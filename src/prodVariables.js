const path = require("path");
const { app } = require("electron");

//TODO always change this to FALSE when publishing
const DEV_MODE = false;

//iconURL http://www.iconj.com/ico/h/p/hpwvy4b6kc.ico
module.exports = {
  DEV_MODE,
  //TODO check if this is platform agnostic
  srcDir: __dirname,
  /**
   * Resolves the path to a directory in the standard system locations
   */
  resolveDir: dir => {
    return path.resolve(DEV_MODE ? __dirname : app.getPath("userData"), dir);
  }
};
