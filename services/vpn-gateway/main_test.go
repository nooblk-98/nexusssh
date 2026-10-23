package main

import (
	"bufio"
	"bytes"
	"crypto/ecdh"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"
)

func keyPair(t *testing.T) (string, string) {
	t.Helper()
	k, e := ecdh.X25519().GenerateKey(rand.Reader)
	if e != nil {
		t.Fatal(e)
	}
	return base64.StdEncoding.EncodeToString(k.Bytes()), base64.StdEncoding.EncodeToString(k.PublicKey().Bytes())
}
func TestListenPort(t *testing.T) {
	private, public := keyPair(t)
	c := Config{PrivateKey: private, Addresses: []string{"10.78.0.2/32"}, MTU: 1420, Peers: []Peer{{PublicKey: public, Endpoint: "127.0.0.1:9", AllowedIPs: []string{"10.78.0.1/32"}}}}
	for _, invalid := range []int{-1, 65536} {
		c.ListenPort = invalid
		if tunnel, err := newTunnel(c); err == nil {
			tunnel.dev.Close()
			t.Fatalf("accepted invalid listen port %d", invalid)
		}
	}
	c.ListenPort = 0
	auto, err := newTunnel(c)
	if err != nil {
		t.Fatal(err)
	}
	settings, err := auto.dev.IpcGet()
	auto.dev.Close()
	if err != nil {
		t.Fatal(err)
	}
	for _, line := range strings.Split(settings, "\n") {
		if strings.HasPrefix(line, "listen_port=") {
			c.ListenPort, err = strconv.Atoi(strings.TrimPrefix(line, "listen_port="))
			if err != nil {
				t.Fatal(err)
			}
		}
	}
	if c.ListenPort == 0 {
		t.Fatal("automatic port was not allocated")
	}
	fixed, err := newTunnel(c)
	if err != nil {
		t.Fatal(err)
	}
	defer fixed.dev.Close()
	settings, err = fixed.dev.IpcGet()
	if err != nil || !strings.Contains(settings, fmt.Sprintf("listen_port=%d\n", c.ListenPort)) {
		t.Fatal("configured listen port was not applied")
	}
}
func TestWireGuardTunnel(t *testing.T) {
	serverKey, serverPublic := keyPair(t)
	clientKey, clientPublic := keyPair(t)
	remote, e := newTunnel(Config{PrivateKey: serverKey, Addresses: []string{"10.77.0.1/32"}, MTU: 1420, Peers: []Peer{{PublicKey: clientPublic, Endpoint: "127.0.0.1:9", AllowedIPs: []string{"10.77.0.2/32"}}}})
	if e != nil {
		t.Fatal(e)
	}
	defer remote.dev.Close()
	settings, e := remote.dev.IpcGet()
	if e != nil {
		t.Fatal(e)
	}
	port := ""
	for _, line := range strings.Split(settings, "\n") {
		if strings.HasPrefix(line, "listen_port=") {
			port = strings.TrimPrefix(line, "listen_port=")
		}
	}
	if port == "" || port == "0" {
		t.Fatal("no WireGuard listen port")
	}
	listener, e := remote.network.ListenTCP(&net.TCPAddr{IP: net.ParseIP("10.77.0.1"), Port: 2222})
	if e != nil {
		t.Fatal(e)
	}
	defer listener.Close()
	go func() {
		for {
			c, e := listener.Accept()
			if e != nil {
				return
			}
			go func() { defer c.Close(); _, _ = io.Copy(c, c) }()
		}
	}()
	g := &gateway{secret: strings.Repeat("x", 64), tunnels: map[string]*tunnel{}}
	defer func() {
		for _, v := range g.tunnels {
			v.dev.Close()
		}
	}()
	srv := httptest.NewServer(g)
	defer srv.Close()
	id := strings.Repeat("a", 64)
	c := Config{PrivateKey: clientKey, Addresses: []string{"10.77.0.2/32"}, MTU: 1420, Peers: []Peer{{PublicKey: serverPublic, Endpoint: "127.0.0.1:" + port, AllowedIPs: []string{"10.77.0.1/32"}}}}
	data, _ := json.Marshal(c)
	for i := 0; i < 2; i++ {
		req, _ := http.NewRequest("PUT", srv.URL+"/tunnels", bytes.NewReader(data))
		req.Header.Set("X-Nexus-Internal", g.secret)
		req.Header.Set("X-Nexus-Tunnel", id)
		req.Header.Set("X-Nexus-Profile", id)
		r, e := http.DefaultClient.Do(req)
		if e != nil {
			t.Fatal(e)
		}
		r.Body.Close()
		if r.StatusCode != 204 {
			t.Fatalf("initialize: %d", r.StatusCode)
		}
	}
	dial := func(target, secret string) (net.Conn, *bufio.Reader, int) {
		t.Helper()
		s, e := net.Dial("tcp", strings.TrimPrefix(srv.URL, "http://"))
		if e != nil {
			t.Fatal(e)
		}
		s.SetDeadline(time.Now().Add(20 * time.Second))
		fmt.Fprintf(s, "CONNECT %s HTTP/1.1\r\nHost: %s\r\nX-Nexus-Internal: %s\r\nX-Nexus-Tunnel: %s\r\n\r\n", target, target, secret, id)
		reader := bufio.NewReader(s)
		r, e := http.ReadResponse(reader, &http.Request{Method: "CONNECT"})
		if e != nil {
			t.Fatal(e)
		}
		return s, reader, r.StatusCode
	}
	// Concurrent streams share one WireGuard device, avoiding peer endpoint roaming.
	a, ar, status := dial("10.77.0.1:2222", g.secret)
	defer a.Close()
	if status != 200 {
		t.Fatalf("connect: %d", status)
	}
	b, br, status := dial("10.77.0.1:2222", g.secret)
	defer b.Close()
	if status != 200 {
		t.Fatalf("second connect: %d", status)
	}
	for i, s := range []net.Conn{a, b, a} {
		_, _ = s.Write([]byte("wireguard"))
		r := ar
		if i == 1 {
			r = br
		}
		out := make([]byte, 9)
		if _, e := io.ReadFull(r, out); e != nil {
			t.Fatal(e)
		}
		if string(out) != "wireguard" {
			t.Fatal("bad tunnel payload")
		}
	}
	denied, _, status := dial("10.88.0.1:2222", g.secret)
	denied.Close()
	if status != 403 {
		t.Fatalf("route should be denied: %d", status)
	}
	denied, _, status = dial("10.77.0.1:2222", "wrong")
	denied.Close()
	if status != 401 {
		t.Fatalf("auth should be denied: %d", status)
	}
}
