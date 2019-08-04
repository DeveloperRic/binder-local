const path = require("path");
const { app } = require("electron");
require("dotenv").config();

//TODO always change this to FALSE when publishing
const DEV_MODE = false;

module.exports = {
  DEV_MODE,
  srcDir: __dirname,
  /**
   * Resolves the path to a directory in the standard system locations
   */
  resolveDir: dir => {
    return path.resolve(DEV_MODE ? __dirname : app.getPath("userData"), dir);
  },
  API_DOMAIN: DEV_MODE ? "http://localhost:3000" : process.env.BINDER_API_DOMAIN
};

//build iconURL http://www.iconj.com/ico/h/p/hpwvy4b6kc.ico
