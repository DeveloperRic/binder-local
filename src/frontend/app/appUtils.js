const { BrowserWindow } = require("electron");

/**
 * calls window.loadFile pointing to the view specified
 * @param {BrowserWindow} window
 * @param {string} viewName excluding '.pug'
 */
function loadView(window, viewName) {
  window.loadFile(`src/frontend/views/layout.pug`);
  window.webContents.openDevTools({ mode: "undocked" });
}
function getViewComponentUrl(viewName) {
  let dir = __dirname;
  dir = dir.substr(0, dir.lastIndexOf("\\"));
  while (dir.includes("\\")) dir = dir.replace("\\", "/");
  return `file:///${dir}/views/components/${viewName}.pug`;
}
module.exports = {
  loadView: loadView,
  getViewComponentUrl: getViewComponentUrl
};
