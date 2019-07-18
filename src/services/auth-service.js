const jwtDecode = require("jwt-decode");
const request = require("request");
const url = require("url");
const keytar = require("keytar");
const os = require("os");
require("dotenv").config();

var API_IDENTIFIER = "https://binder-local";
var AUTH0_DOMAIN = "binderapp.auth0.com";
var CLIENT_ID = "M5PeIwqsIhs0ZZ3vjyrFU9k1Zm3vVWzb";

const REDIRECT_URI = `file:///auth0-callback`;

const KEYTAR_SERVICE = "electron-openid-oauth";
const KEYTAR_ACCOUNT = os.userInfo().username;

let accessToken = null;
let profile = null;
let refreshToken = null;

function getAccessToken() {
  return accessToken;
}

function getProfile() {
  return profile;
}

function getAuthenticationURL() {
  return (
    "https://" +
    AUTH0_DOMAIN +
    "/authorize?" +
    "audience=" +
    API_IDENTIFIER +
    "&" +
    "scope=openid profile email offline_access&" +
    "response_type=code&" +
    "client_id=" +
    CLIENT_ID +
    "&" +
    "redirect_uri=" +
    REDIRECT_URI
  );
}

function refreshTokens() {
  return new Promise((resolve, reject) => {
    keytar
      .getPassword(KEYTAR_SERVICE, KEYTAR_ACCOUNT)
      .then(refreshToken => {
        if (!refreshToken) return reject();

        const refreshOptions = {
          method: "POST",
          url: `https://${AUTH0_DOMAIN}/oauth/token`,
          headers: { "content-type": "application/json" },
          body: {
            grant_type: "refresh_token",
            client_id: CLIENT_ID,
            refresh_token: refreshToken
          },
          json: true
        };

        request(refreshOptions, (error, response, body) => {
          if (error || body.error) {
            return logout()
              .then(() => reject(error || body.error))
              .catch(reject);
          }

          accessToken = body.access_token;
          profile = jwtDecode(body.id_token);
          resolve();
        });
      })
      .catch(reject);
  });
}

function loadTokens(callbackURL) {
  return new Promise((resolve, reject) => {
    const urlParts = url.parse(callbackURL, true);
    const query = urlParts.query;

    const exchangeOptions = {
      grant_type: "authorization_code",
      client_id: CLIENT_ID,
      code: query.code,
      redirect_uri: REDIRECT_URI
    };

    const options = {
      method: "POST",
      url: `https://${AUTH0_DOMAIN}/oauth/token`,
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify(exchangeOptions)
    };

    request(options, (error, response, body) => {
      if (error || body.error) {
        return logout()
          .then(() => reject(error || body.error))
          .catch(reject);
      }
      const responseBody = JSON.parse(body);
      accessToken = responseBody.access_token;
      profile = jwtDecode(responseBody.id_token);
      refreshToken = responseBody.refresh_token;

      keytar.setPassword(KEYTAR_SERVICE, KEYTAR_ACCOUNT, refreshToken);

      resolve();
    });
  });
}

function logout() {
  return new Promise((resolve, reject) => {
    keytar.deletePassword(KEYTAR_SERVICE, KEYTAR_ACCOUNT).then(() => {
      accessToken = null;
      profile = null;
      refreshToken = null;
    }).then(resolve).catch(reject);
  });
}

function getLogOutUrl() {
  return `https://${AUTH0_DOMAIN}/v2/logout`;
}

module.exports = {
  getAccessToken,
  getAuthenticationURL,
  getLogOutUrl,
  getProfile,
  loadTokens,
  logout,
  refreshTokens
};
