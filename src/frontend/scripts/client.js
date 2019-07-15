var app = angular.module("app", [
  "ngRoute",
  "ngCookies",
  "ngSanitize",
  "ui.bootstrap.contextMenu",
  "infinite-scroll"
  // "angular-inview"
]);

/*
THIS IS MEANT TO BE A GLOBALS FILE
WHERE CONSTANTS, STATE_VARS AND COMMONLY-USED FUNCTIONS
WILL BE HELD.
*/

app.config(function($routeProvider) {
  // $routeProvider
  //   .when("/home", {
  //     templateUrl: "components/home.pug"
  //   })
  //   .when("/plans", {
  //     templateUrl: "components/plans.pug"
  //   })
  //   .otherwise({
  //     templateUrl: "components/home.pug"
  //   });
});

app.run(function($rootScope, $cookies) {
  const { remote, ipcRenderer } = require("electron");
  const { getAccessToken, getProfile } = remoteRequire("services/auth-service");
  const { createLogoutWindow } = remoteRequire("frontend/app/auth-process");
  const { clientModels, relaunch, getViewComponentUrl } = remoteRequire(
    "frontend/app/app-process"
  );
  var User = clientModels.User;
  var stageStack = [];
  var stageStackIndex = -1;
  const G = ($rootScope.G = {
    remote,
    lang: {},
    setLang,
    saveUid,
    validateEmail,
    validatePassword,
    popup: null,
    showPopup,
    oauthHeader,
    require: remoteRequire,
    stripePublishableKey: "pk_test_fX7mdGyHoDRM5jd28IL6nmzF00pXMoMcT9",
    getUser,
    user: {},
    profile: getProfile(),
    switchStage,
    stageStack: {
      stack: stageStack,
      index: stageStackIndex,
      src: null,
      canBack: false,
      back: stageBack,
      canForward: false,
      forward: stageForward,
      current: () => stageStack[stageStackIndex].id,
      switchArgs: {}
    },
    logout,
    restart: relaunch,
    error: {
      visible: false,
      message: ""
    },
    choose: {
      visible: false
    },
    loadingPopup: {
      visible: false
    },
    notifyError,
    notifyChoose,
    clientModels: clientModels,
    ipcRenderer: {
      send: ipcRenderer.send,
      sendSync: ipcRenderer.sendSync,
      on: ipcRenderer.on
    },
    regexEscape,
    refreshCtrl: () => {}
  });
  function regexEscape(s) {
    if (!RegExp.escape) {
      RegExp.escape = s => s.replace(/[-\/\\^$*+?.()|[\]{}]/g, "\\$&");
    }
    return RegExp.escape(s);
  }
  function switchStage(stage, ...args) {
    if (stageStackIndex >= 0 && stageStack[stageStackIndex].id == stage) {
      return;
    }
    stageStack.splice(++stageStackIndex, stageStack.length - stageStackIndex, {
      id: stage,
      src: getViewComponentUrl(stage)
    });
    G.stageStack.canBack = stageStackIndex > 0;
    G.stageStack.canForward = stageStackIndex < stageStack.length - 1;
    G.stageStack.src = stageStack[stageStackIndex].src;
    G.stageStack.switchArgs = {};
    G.stageStack.switchArgs[stage] = args;
  }
  function stageBack() {
    if (G.stageStack.canBack) {
      G.stageStack.src = stageStack[--stageStackIndex].src;
      G.stageStack.canBack = stageStackIndex > 0;
      G.stageStack.canForward = stageStackIndex < stageStack.length - 1;
    }
  }
  function stageForward() {
    if (G.stageStack.canForward) {
      G.stageStack.src = stageStack[++stageStackIndex].src;
      G.stageStack.canBack = stageStackIndex > 0;
      G.stageStack.canForward = stageStackIndex < stageStack.length - 1;
    }
  }
  function notifyChoose(type, data, onChoose) {
    if (G.choose.visible) {
      G.choose.finish();
    }
    G.choose = {
      type: type,
      visible: true,
      parent: null,
      selected: null,
      stack: [],
      stackIndex: -1,
      back: () => {
        G.choose.stack.pop();
        G.choose.parent = G.choose.stack[--G.choose.stackIndex];
        G.choose.selected = null;
      },
      up: () => {
        G.choose.stack.push((G.choose.parent = G.choose.parent.parent));
        G.choose.stackIndex++;
        G.choose.selected = null;
      },
      select: item => {
        G.choose.selected = item;
      },
      finish: () => {
        onChoose(G.choose.selected);
        G.choose = { visible: false };
      },
      start: root => {
        G.choose.stack.push((G.choose.parent = root));
        G.choose.stackIndex++;
      },
      cancel: () => {
        G.choose.selected = null;
        G.choose.finish();
      }
    };
    G.choose.start(data);
  }
  function notifyError(msg, data) {
    if (data) console.error(msg, data);
    if (typeof msg == "object") {
      G.error.message = null;
      G.error.messages = msg;
    } else {
      G.error.message = msg;
      G.error.messages = null;
    }
    G.error.visible = true;
  }
  function getUser(callback) {
    User.findOneAndUpdate(
      { email: G.profile.email },
      {
        email_verified: G.profile.email_verified,
        profile: {
          nickname: G.profile.nickname,
          picture: G.profile.picture
        }
      },
      { upsert: true, new: true },
      (err, user) => {
        if (err) return callback(err);
        if (!user.email_verified) {
          user.plan = null;
        }
        callback(false, user);
      }
    ).lean(true);
  }
  function logout(callback) {
    if (!callback) callback = () => {};
    createLogoutWindow().then(callback);
    // .then(() => remote.getCurrentWindow().close());
  }
  function remoteRequire(module) {
    return remote.require("./" + module);
  }
  function oauthHeader(options) {
    let header = {
      headers: {
        Authorization: `Bearer ${getAccessToken()}`
      }
    };
    if (options) return Object.assign(header, options);
    else return header;
  }
  // $cookies.put("useDarkModeTheme", true);
  $rootScope.useDarkModeTheme = !!$cookies.get("useDarkModeTheme");
  function setLang(data) {
    if (data.uid) saveUid({ uid: data.uid });
    G.lang = data.lang;
    G.refreshCtrl();
  }
  function saveUid(user) {
    let expires = new Date(Date.now() + G.LOGIN_DURATION);
    $cookies.put("uid", user.uid, { expires: expires });
    G.uid = user.uid;
  }
  function validateEmail(email) {
    return /^(([^<>()\[\]\\.,;:\s@"]+(\.[^<>()\[\]\\.,;:\s@"]+)*)|(".+"))@((\[[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\])|(([a-zA-Z\-0-9]+\.)+[a-zA-Z]{2,}))$/.test(
      String(email).toLowerCase()
    );
  }
  function validatePassword(password, passwordconfirm) {
    if (password == "") {
      return "You must enter a password.";
    } else if (password.length < 8) {
      return new Array(
        "Your password must be at least 8 characters long.",
        "This is to help protect your files from unauthorised access."
      );
    } else if (password != passwordconfirm) {
      return "Your passwords do not match.";
    } else {
      return null;
    }
  }
  function showPopup(type, title, details, options) {
    var view = "/api/file/popup/" + type.toLowerCase();
    G.popup = {
      popupView: view,
      title: title,
      details: details,
      close: () => (G.popup = null)
    };
    if (options) {
      G.popup = Object.assign(G.popup, options);
    }
  }
  G.switchStage("home");
});
