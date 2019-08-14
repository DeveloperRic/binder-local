const net = require("net");

let previous = false;
let connected = true;
let running = false;
let process;

function start(callback) {
  stop();
  process = setInterval(task, 20000, callback);
}

function task(callback) {
  if (running) return;
  running = true;
  tryConnect(1);
  function tryConnect(tries) {
    let allowResponse = true;
    let timeout = null;
    let done = disconnected => {
      if (!allowResponse) return;
      allowResponse = false;
      clearTimeout(timeout);
      socket.end();
      socket.unref();
      if (disconnected && tries < 2) {
        setTimeout(() => tryConnect(tries + 1), 5000);
      } else {
        previous = connected;
        connected = !disconnected;
        callback(connected, previous);
      }
    };
    let socket = net
      .connect({
        port: 80,
        host: "binder-ping.000webhostapp.com",
        timeout: 5000
      })
      .on("error", done)
      .on("connect", done);
    timeout = setTimeout(() => done(true), 5000);
  }
}

function stop() {
  if (!process) return;
  clearInterval(process);
}

module.exports = {
  start,
  stop
};
