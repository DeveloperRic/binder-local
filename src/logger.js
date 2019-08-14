const winston = require("winston");
const { DEV_MODE, resolveDir } = require("./prodVariables");

const transports = DEV_MODE
  ? [new winston.transports.Console()]
  : [
      new winston.transports.Console({ level: "info" }),
      new winston.transports.File({
        filename: resolveDir("data/errors.log"),
        level: "info"
      })
    ];

module.exports = winston.createLogger({
  levels: winston.config.syslog.levels,
  format: winston.format.timestamp(),
  transports
});
