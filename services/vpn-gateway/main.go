package main

import (
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/netip"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"

	"golang.zx2c4.com/wireguard/conn"
	"golang.zx2c4.com/wireguard/device"
	"golang.zx2c4.com/wireguard/tun/netstack"
)

type Peer struct {
	PublicKey           string   `json:"publicKey"`
	PresharedKey        string   `json:"presharedKey"`
	Endpoint            string   `json:"endpoint"`
	AllowedIPs          []string `json:"allowedIPs"`
	PersistentKeepalive int      `json:"persistentKeepalive"`
}
type Config struct {
	PrivateKey string   `json:"privateKey"`
	Addresses  []string `json:"addresses"`
	DNS        []string `json:"dns"`
	MTU        int      `json:"mtu"`
	ListenPort int      `json:"listenPort"`
	Peers      []Peer   `json:"peers"`
}
type tunnel struct {
	profile string
	dev     *device.Device
	network *netstack.Net
	routes  []netip.Prefix
	digest  [32]byte
	active  int
	used    time.Time
}
type gateway struct {
	mu      sync.Mutex
	tunnels map[string]*tunnel
	secret  string
}

func keyHex(value string) (string, error) {
	b, e := base64.StdEncoding.DecodeString(value)
	if e != nil || len(b) != 32 {
		return "", errors.New("invalid key")
	}
	return hex.EncodeToString(b), nil
}
func newTunnel(c Config) (*tunnel, error) {
	if c.ListenPort < 0 || c.ListenPort > 65535 {
		return nil, errors.New("invalid listen port")
	}
	if len(c.Addresses) == 0 || len(c.Addresses) > 8 || len(c.Peers) == 0 || len(c.Peers) > 16 || c.MTU < 1280 || c.MTU > 1500 {
		return nil, errors.New("invalid configuration")
	}
	addresses := []netip.Addr{}
	dns := []netip.Addr{}
	routes := []netip.Prefix{}
	for _, s := range c.Addresses {
		p, e := netip.ParsePrefix(s)
		if e != nil {
			return nil, e
		}
		addresses = append(addresses, p.Addr())
	}
	for _, s := range c.DNS {
		a, e := netip.ParseAddr(s)
		if e != nil {
			return nil, e
		}
		dns = append(dns, a)
	}
	private, e := keyHex(c.PrivateKey)
	if e != nil {
		return nil, e
	}
	var settings strings.Builder
	fmt.Fprintf(&settings, "private_key=%s\n", private)
	fmt.Fprintf(&settings, "listen_port=%d\n", c.ListenPort)
	for _, p := range c.Peers {
		public, e := keyHex(p.PublicKey)
		if e != nil {
			return nil, e
		}
		if p.PersistentKeepalive < 0 || p.PersistentKeepalive > 65535 || len(p.AllowedIPs) == 0 || len(p.AllowedIPs) > 100 {
			return nil, errors.New("invalid peer")
		}
		endpoint, e := net.ResolveUDPAddr("udp", p.Endpoint)
		if e != nil || endpoint.Port < 1 {
			return nil, errors.New("invalid endpoint")
		}
		fmt.Fprintf(&settings, "public_key=%s\nendpoint=%s\npersistent_keepalive_interval=%d\n", public, endpoint.String(), p.PersistentKeepalive)
		if p.PresharedKey != "" {
			key, e := keyHex(p.PresharedKey)
			if e != nil {
				return nil, e
			}
			fmt.Fprintf(&settings, "preshared_key=%s\n", key)
		}
		for _, s := range p.AllowedIPs {
			prefix, e := netip.ParsePrefix(s)
			if e != nil {
				return nil, e
			}
			routes = append(routes, prefix)
			fmt.Fprintf(&settings, "allowed_ip=%s\n", prefix.Masked())
		}
	}
	tun, network, e := netstack.CreateNetTUN(addresses, dns, c.MTU)
	if e != nil {
		return nil, e
	}
	dev := device.NewDevice(tun, conn.NewDefaultBind(), device.NewLogger(device.LogLevelSilent, ""))
	if e = dev.IpcSet(settings.String()); e != nil {
		dev.Close()
		return nil, e
	}
	if e = dev.Up(); e != nil {
		dev.Close()
		return nil, e
	}
	return &tunnel{dev: dev, network: network, routes: routes, used: time.Now()}, nil
}
func (g *gateway) sweep() {
	g.mu.Lock()
	defer g.mu.Unlock()
	for id, t := range g.tunnels {
		if t.active == 0 && time.Since(t.used) > 5*time.Minute {
			t.dev.Close()
			delete(g.tunnels, id)
		}
	}
}
func (g *gateway) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path == "/health" && r.Method == "GET" {
		w.WriteHeader(200)
		return
	}
	if subtle.ConstantTimeCompare([]byte(r.Header.Get("X-Nexus-Internal")), []byte(g.secret)) != 1 {
		http.Error(w, "Unauthorized", 401)
		return
	}
	id := r.Header.Get("X-Nexus-Tunnel")
	if len(id) != 64 {
		http.Error(w, "Invalid tunnel", 400)
		return
	}
	if _, e := hex.DecodeString(id); e != nil {
		http.Error(w, "Invalid tunnel", 400)
		return
	}
	if r.Method == "PUT" && r.URL.Path == "/tunnels" {
		profile := r.Header.Get("X-Nexus-Profile")
		if len(profile) != 64 {
			http.Error(w, "Invalid profile", 400)
			return
		}
		if _, err := hex.DecodeString(profile); err != nil {
			http.Error(w, "Invalid profile", 400)
			return
		}
		var c Config
		decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 65536))
		decoder.DisallowUnknownFields()
		if decoder.Decode(&c) != nil {
			http.Error(w, "Invalid configuration", 400)
			return
		}
		serialized, _ := json.Marshal(c)
		digest := sha256.Sum256(serialized)
		g.mu.Lock()
		defer g.mu.Unlock()
		if existing := g.tunnels[id]; existing != nil {
			if existing.digest != digest || existing.profile != profile {
				http.Error(w, "Tunnel configuration conflict", 409)
				return
			}
			existing.used = time.Now()
			w.WriteHeader(204)
			return
		}
		for oldID, old := range g.tunnels {
			if old.profile == profile {
				if old.active > 0 {
					http.Error(w, "Close active sessions before changing a VPN profile", 409)
					return
				}
				old.dev.Close()
				delete(g.tunnels, oldID)
			}
		}
		if len(g.tunnels) >= 64 {
			http.Error(w, "VPN profile capacity reached", 503)
			return
		}
		t, e := newTunnel(c)
		if e != nil {
			http.Error(w, "Cannot initialize WireGuard profile", 400)
			return
		}
		t.digest = digest
		t.profile = profile
		g.tunnels[id] = t
		w.WriteHeader(204)
		return
	}
	if r.Method == "GET" && r.URL.Path == "/resolve" {
		g.mu.Lock()
		t := g.tunnels[id]
		if t != nil {
			t.active++
			t.used = time.Now()
		}
		g.mu.Unlock()
		if t == nil {
			http.Error(w, "Tunnel unavailable", 404)
			return
		}
		defer func() { g.mu.Lock(); t.active--; t.used = time.Now(); g.mu.Unlock() }()
		ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
		defer cancel()
		addresses, err := t.network.LookupContextHost(ctx, r.URL.Query().Get("host"))
		if err != nil {
			http.Error(w, "VPN DNS lookup failed", 502)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(addresses)
		return
	}
	if r.Method != "CONNECT" {
		http.Error(w, "Not found", 404)
		return
	}
	host, port, e := net.SplitHostPort(r.Host)
	p, pe := strconv.Atoi(port)
	// Accept numeric targets only. Resolution and the application destination allowlist
	// are enforced by ssh-core; a private DNS lookup is requested separately below.
	address, ae := netip.ParseAddr(host)
	if e != nil || pe != nil || p < 1 || p > 65535 || ae != nil {
		http.Error(w, "Invalid destination", 400)
		return
	}
	g.mu.Lock()
	t := g.tunnels[id]
	if t == nil {
		g.mu.Unlock()
		http.Error(w, "Tunnel unavailable", 404)
		return
	}
	allowed := false
	for _, prefix := range t.routes {
		if prefix.Contains(address) {
			allowed = true
			break
		}
	}
	if !allowed {
		g.mu.Unlock()
		http.Error(w, "Destination outside WireGuard AllowedIPs", 403)
		return
	}
	t.active++
	t.used = time.Now()
	g.mu.Unlock()
	defer func() { g.mu.Lock(); t.active--; t.used = time.Now(); g.mu.Unlock() }()
	ctx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
	defer cancel()
	upstream, e := t.network.DialContext(ctx, "tcp", net.JoinHostPort(host, port))
	if e != nil {
		http.Error(w, "VPN connection failed", 502)
		return
	}
	defer upstream.Close()
	downstream, rw, e := w.(http.Hijacker).Hijack()
	if e != nil {
		return
	}
	defer downstream.Close()
	_ = downstream.SetDeadline(time.Time{})
	if _, e = rw.WriteString("HTTP/1.1 200 Connection Established\r\n\r\n"); e != nil {
		return
	}
	if rw.Flush() != nil {
		return
	}
	done := make(chan struct{})
	go func() { _, _ = io.Copy(upstream, rw); _ = upstream.Close(); close(done) }()
	_, _ = io.Copy(downstream, upstream)
	_ = downstream.Close()
	<-done
}
func main() {
	secret := os.Getenv("INTERNAL_SECRET")
	if len(secret) < 48 {
		log.Fatal("INTERNAL_SECRET must have at least 48 characters")
	}
	g := &gateway{tunnels: map[string]*tunnel{}, secret: secret}
	go func() {
		for range time.Tick(time.Minute) {
			g.sweep()
		}
	}()
	address := os.Getenv("VPN_LISTEN_ADDR")
	if address == "" {
		address = "127.0.0.1:3003"
	}
	server := &http.Server{Addr: address, Handler: g, ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 20 * time.Second, IdleTimeout: 60 * time.Second, MaxHeaderBytes: 8192}
	log.Print("WireGuard gateway listening on :3003")
	log.Fatal(server.ListenAndServe())
}
