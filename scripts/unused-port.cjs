// A loopback port for a server a test cannot start on port 0: a child process
// told its port on the command line, or a list of ports handed to the code
// under test. Picking one with listen(0) and closing it hands out an
// ephemeral port, and the OS may give that same port to any outgoing
// connection before the server binds it (EADDRINUSE, or a dead URL that
// suddenly answers). These ports sit below every ephemeral range (Linux starts
// at 32768, macOS and Windows at 49152), so only another test picking in the
// same range could take one, and the probe skips a port in use. It probes
// 127.0.0.1 only, and a machine whose ephemeral range was widened below 30000
// would bring the overlap back.
//
//   const { unusedPort } = require("./unused-port.cjs");
//   const port = await unusedPort();            // nothing listens there
//   const other = await unusedPort(new Set([port]));
const net = require("node:net");

const UNUSED_PORT_MIN = 20_000;
const UNUSED_PORT_SPAN = 10_000;

function probe(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.listen({ host: "127.0.0.1", port, exclusive: true }, () => server.close(() => resolve(true)));
  });
}

async function unusedPort(avoid = new Set()) {
  for (let i = 0; i < 200; i += 1) {
    const port = UNUSED_PORT_MIN + Math.floor(Math.random() * UNUSED_PORT_SPAN);
    if (avoid.has(port)) continue;
    if (await probe(port)) return port;
  }
  throw new Error(`no unused port in ${UNUSED_PORT_MIN}-${UNUSED_PORT_MIN + UNUSED_PORT_SPAN - 1}`);
}

module.exports = { unusedPort, UNUSED_PORT_MIN, UNUSED_PORT_SPAN };
