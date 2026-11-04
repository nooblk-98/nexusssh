import { createInterface } from "node:readline";

// Yields the data payload of each server-sent event in a response body.
export async function* events(body) {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true });
    let end;
    while ((end = buffer.search(/\r?\n\r?\n/)) >= 0) {
      const raw = buffer.slice(0, end);
      buffer = buffer.slice(end).replace(/^\r?\n\r?\n/, "");
      const data = raw
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).replace(/^ /, ""))
        .join("\n");
      if (data) yield data;
    }
  }
}

// Relays newline-delimited JSON-RPC on stdio to the Streamable HTTP endpoint,
// for clients that only launch local servers. Requests run concurrently so a
// long tool call never blocks pings or cancellations.
export function bridge({
  url,
  token,
  input = process.stdin,
  output = process.stdout,
  log = (line) => process.stderr.write(line + "\n"),
}) {
  let session, version;
  const pending = new Set();
  const send = (message) => output.write(JSON.stringify(message) + "\n");
  const deliver = (text) => {
    let value;
    try {
      value = JSON.parse(text);
    } catch {
      return log("nexusssh-mcp: ignored a malformed server message");
    }
    for (const message of [value].flat()) {
      if (message?.result?.protocolVersion && message.result.serverInfo)
        version = message.result.protocolVersion;
      send(message);
    }
  };
  async function forward(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return log("nexusssh-mcp: ignored a non-JSON line on stdin");
    }
    const id = Array.isArray(message) ? undefined : message.id;
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          ...(session && { "mcp-session-id": session }),
          ...(version && { "mcp-protocol-version": version }),
        },
        body: line,
      });
      session = res.headers.get("mcp-session-id") || session;
      if (!res.ok) {
        await res.body?.cancel();
        const denied = res.status === 401 || res.status === 403;
        throw new Error(
          `HTTP ${res.status}${denied ? ": the agent token was rejected or revoked" : ""}`,
        );
      }
      if ((res.headers.get("content-type") || "").includes("text/event-stream"))
        for await (const data of events(res.body)) deliver(data);
      else {
        const text = await res.text();
        if (text.trim()) deliver(text);
      }
    } catch (e) {
      log(`nexusssh-mcp: ${e.message}`);
      if (id !== undefined)
        send({
          jsonrpc: "2.0",
          id,
          error: { code: -32000, message: `NexusSSH: ${e.message}` },
        });
    }
  }
  return new Promise((resolve) => {
    const lines = createInterface({ input, crlfDelay: Infinity });
    lines.on("line", (line) => {
      if (!line.trim()) return;
      const task = forward(line).finally(() => pending.delete(task));
      pending.add(task);
    });
    lines.on("close", () => void Promise.all(pending).then(resolve));
  });
}
