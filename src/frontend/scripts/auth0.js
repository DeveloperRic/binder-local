const { remote } = require("electron");
const axios = require("axios");
const { API_DOMAIN } = remote.require("./prodVariables");
const authService = remote.require("./services/auth-service");
const authProcess = remote.require("./frontend/app/auth-process");

const webContents = remote.getCurrentWebContents();

webContents.on("dom-ready", () => {
  const profile = authService.getProfile();
  document.getElementById("picture").src = profile.picture;
  document.getElementById("name").innerText = profile.name;
  document.getElementById("success").innerText =
    "You successfully used OpenID Connect and OAuth 2.0 to authenticate.";
});

document.getElementById("logout").onclick = () => {
  authProcess
    .createLogoutWindow()
    .then(() => remote.getCurrentWindow().close());
};

document.getElementById("secured-request").onclick = () => {
  axios
    .get(`${API_DOMAIN}/client/auth/private`, {
      headers: {
        Authorization: `Bearer ${authService.getAccessToken()}`
      }
    })
    .then(response => {
      const messageJumbotron = document.getElementById("message");
      messageJumbotron.innerText = response.data;
      messageJumbotron.style.display = "block";
    })
    .catch(error => {
      console.error(error);
    });
};
