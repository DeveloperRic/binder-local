var app = angular.module("app", [
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

app.run(function($rootScope, $cookies, $interval, $http) {
  const { remote, ipcRenderer, shell } = require("electron");
  const { getProfile } = remoteRequire("services/auth-service");
  const { createLogoutWindow, createAuthWindow } = remoteRequire(
    "frontend/app/auth-process"
  );
  const { regexEscape, toObjectId, beginSession, oauthHeader } = remoteRequire(
    "services/coordination"
  );
  const {
    clientModels,
    relaunch,
    getViewComponentUrl,
    hideAppWindow,
    showAppWindow
  } = remoteRequire("frontend/app/app-process");
  const {
    DEV_MODE,
    API_DOMAIN,
    LOCAL_SETTINGS_PATH,
    resolveDir
  } = remoteRequire("prodVariables");
  const User = clientModels.User;
  const Plan = clientModels.Plan;
  const Block = clientModels.Block;
  const stageStack = [];
  let stageStackIndex = -1;
  const stripePublishableKey = "pk_test_fX7mdGyHoDRM5jd28IL6nmzF00pXMoMcT9";
  const G = ($rootScope.G = {
    remote,
    ipcRenderer,
    shell,
    lang: {},
    setLang,
    saveUid,
    validateEmail,
    validatePassword,
    popup: null,
    showPopup,
    oauthHeader,
    require: remoteRequire,
    API_DOMAIN,
    LOCAL_SETTINGS_PATH,
    resolveDir,
    paymentService: { purchaseEndpoint },
    getUser,
    user: {},
    profile: getProfile(),
    logoName: "logo",
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
      msg: null,
      visible: false
    },
    infoPopup: {
      msg: [],
      visible: false,
      delayTask: null
    },
    notifyError,
    notifyChoose,
    notifyLoading,
    notifyInfo,
    clientModels,
    regexEscape,
    toObjectId,
    beginSession,
    dateToTime,
    authorize,
    initialiseStripe,
    refreshCtrl: () => {}
  });
  function authorize(callback) {
    hideAppWindow();
    createAuthWindow(authorized => {
      showAppWindow();
      callback(authorized);
    });
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
    if (args.length > 0) {
      G.stageStack.switchArgs[stage] = args;
    }
  }
  function stageBack() {
    if (G.stageStack.canBack) {
      G.stageStack.src = stageStack[--stageStackIndex].src;
      G.stageStack.canBack = stageStackIndex > 0;
      G.stageStack.canForward = stageStackIndex < stageStack.length - 1;
      G.stageStack.switchArgs = {};
    }
  }
  function stageForward() {
    if (G.stageStack.canForward) {
      G.stageStack.src = stageStack[++stageStackIndex].src;
      G.stageStack.canBack = stageStackIndex > 0;
      G.stageStack.canForward = stageStackIndex < stageStack.length - 1;
      G.stageStack.switchArgs = {};
    }
  }
  function notifyLoading(popupVisible, popupMsg) {
    G.loadingPopup.visible = popupVisible;
    G.loadingPopup.msg = popupMsg;
  }
  function notifyInfo(popupMsg, allowDismiss = true, onClose, delayConfirm) {
    G.infoPopup.visible = !!popupMsg;
    if (popupMsg == null) {
      G.infoPopup.msg = [];
    } else if (typeof popupMsg == "string") {
      G.infoPopup.msg = [popupMsg];
    } else {
      G.infoPopup.msg = popupMsg;
    }
    $interval.cancel(G.infoPopup.delayTask);
    delete G.infoPopup.delayConfirm;
    if (G.infoPopup.msg.length > 0) {
      G.infoPopup.allowDismiss = allowDismiss;
      G.infoPopup.close = confirmed => {
        G.infoPopup.visible = false;
        console.log(confirmed);
        if (onClose) onClose(confirmed);
      };
      if (delayConfirm) {
        G.infoPopup.delayConfirm = true;
        G.infoPopup.delayTask = $interval(
          () => delete G.infoPopup.delayConfirm,
          Math.min(5000, 1000 * G.infoPopup.msg.length),
          1
        );
      }
    }
  }
  function notifyChoose(options, data, onChoose) {
    if (G.choose.visible) {
      G.choose.finish();
    }
    G.choose = {
      type: options.type || options,
      visible: true,
      parent: null,
      selections: [],
      stack: [],
      stackIndex: -1,
      back: () => {
        G.choose.stack.pop();
        G.choose.parent = G.choose.stack[--G.choose.stackIndex];
        G.choose.selections = [];
      },
      up: () => {
        G.choose.stack.push((G.choose.parent = G.choose.parent.parent));
        G.choose.stackIndex++;
        G.choose.selections = [];
      },
      select: item => {
        let index = G.choose.selections.indexOf(item);
        if (index < 0) {
          if (G.choose.selections.length > 0 && !options.multiSelect) {
            G.choose.selections.length = 0;
          }
          G.choose.selections.push(item);
        } else {
          G.choose.selections.splice(index, 1);
        }
      },
      finish: () => {
        onChoose(
          options.multiSelect ? G.choose.selections : G.choose.selections[0]
        );
        G.choose = { visible: false };
      },
      start: root => {
        G.choose.stack.push((G.choose.parent = root));
        G.choose.stackIndex++;
      },
      cancel: () => {
        G.choose.selections = [];
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
  function getUser(callback, ...projections) {
    let projection = {
      email: 1,
      email_verified: 1
    };
    let planProjection = {};
    let hasExcludedPlan = false;
    projections.forEach(proj => {
      let exclude = proj.startsWith("-");
      if (exclude) proj = proj.substr(1);
      if (proj.startsWith("plan.")) {
        if (!hasExcludedPlan && exclude) {
          hasExcludedPlan = true;
        }
        planProjection[proj.substr(5)] = exclude ? 0 : 1;
      } else {
        projection[proj] = exclude ? 0 : 1;
      }
    });
    projection.plan = 1;
    if (!hasExcludedPlan) {
      planProjection.active = 1;
    }
    User.findOne({ email: G.profile.email }, projection, (err, user) => {
      if (err) return callback(err);
      if (!user) {
        return callback(new Error("Logged in user not found in MongoDB"));
      }
      if (!user.email_verified) {
        user.plan = null;
      }
      user._id = user._id.toString();
      if (user.plan) {
        Plan.findOne(
          { _id: user.plan, active: true },
          planProjection,
          (err, plan) => {
            if (err) return callback(err);
            user.plan = plan;
            if (!plan) {
              user.plan_inactive = true;
              user.inactive_plan = user.plan;
              callback(false, user);
            } else {
              Block.find(
                {
                  plan: plan._id,
                  provisioned: false
                },
                { _id: 1 },
                (err, blocks) => {
                  if (err) return callback(err);
                  if (blocks.length > 0) {
                    user.plan_inactive = true;
                    user.awaiting_provision = true;
                    user.inactive_plan = user.plan;
                    user.plan = null;
                  }
                  callback(false, user);
                }
              )
                .limit(1)
                .lean(true);
            }
          }
        ).lean(true);
      } else {
        callback(false, user);
      }
    }).lean(true);
  }
  function logout(callback, verify) {
    setImmediate(() => {
      if (verify || !callback) {
        G.notifyInfo("Are you sure you want to logout?", false, confirmed => {
          if (!confirmed) return;
          if (!callback) {
            callback = () => G.restart();
          }
          createLogoutWindow().then(callback);
        });
        $rootScope.$apply();
      } else {
        createLogoutWindow().then(callback);
      }
    });
  }
  function remoteRequire(module) {
    return remote.require("./" + module);
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
  /**
   * Initialises Stripe elements and sets up payment input
   * @param {{elementId: string, errorId: string}} elementInfo for example "#card-element" and "#card-errors"
   * @param {function(string)} paymentFunction tokenId is sent here
   */
  function initialiseStripe({elementId, cardErrorId}, paymentFunction) {
    return new Promise((resolve, reject) => {
      let stripe;
      try {
        stripe = Stripe(stripePublishableKey);
      } catch (error) {
        return reject(err);
      }

      var elements = stripe.elements();

      // Custom styling can be passed to options when creating an Element.
      // (Note that this demo uses a wider set of styles than the guide below.)
      var cardElementStyle = {
        base: {
          color: "#32325d",
          fontFamily: '"Helvetica Neue", Helvetica, sans-serif',
          fontSmoothing: "antialiased",
          fontSize: "16px",
          "::placeholder": {
            color: "#aab7c4"
          }
        },
        invalid: {
          color: "#fa755a",
          iconColor: "#fa755a"
        }
      };

      // Create an instance of the card Element.
      var card = elements.create("card", {
        hidePostalCode: true,
        style: cardElementStyle
      });

      // Add an instance of the card Element into the `card-element` <div>.
      card.mount(elementId);

      let cardErrorElement = document.getElementById(cardErrorId.replace("#", ""));
      if (!cardErrorElement) {
        console.error("Failed to get card-error element in Stripe init");
      }

      // Handle real-time validation errors from the card Element.
      card.addEventListener("change", event => {
        if (event.error) {
          cardErrorElement.textContent = event.error.message;
        } else {
          cardErrorElement.textContent = "";
        }
      });

      // Handle form submission.
      var form = document.getElementById("payment-form");
      form.addEventListener("submit", event => {
        console.log("submitting card details");
        event.preventDefault();

        stripe.createToken(card).then(result => {
          if (result.error) {
            // Inform the user if there was an error.
            cardErrorElement.textContent = result.error.message;
          } else {
            // Send the token to your server.
            stripeTokenHandler(result.token);
          }
        });
      });

      // Submit the form with the token ID.
      function stripeTokenHandler(token) {
        // Insert the token ID into the form so it gets submitted to the server
        var form = document.getElementById("payment-form");
        var hiddenInput = document.createElement("input");
        hiddenInput.setAttribute("type", "hidden");
        hiddenInput.setAttribute("name", "stripeToken");
        hiddenInput.setAttribute("value", token.id);
        form.appendChild(hiddenInput);

        // Submit the form
        // form.submit();
        // test token = "tok_visa"
        paymentFunction(token.id);
      }

      resolve(stripe);
    });
  }
  function dateToTime(date) {
    let pad = (num, size) => ("000" + num).slice(size * -1);
    let hours = date.getHours();
    return {
      hours: pad(hours, 2),
      minutes: pad(date.getMinutes(), 2),
      seconds: pad(date.getSeconds(), 2),
      ms: pad(date.getMilliseconds(), 3),
      simpleHours: hours % 12,
      isAm: !(hours > 12 || hours == 0)
    };
  }
  G.ipcRenderer.removeAllListeners("client-internet-check");
  G.ipcRenderer.on("client-internet-check", (event, connected) => {
    G.logoName = connected ? "logo" : "logo-offline";
    $rootScope.$apply();
  });
  G.shortMonths = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec"
  ];
  G.longMonths = [
    "January",
    "February",
    "March",
    "April",
    "May",
    "June",
    "July",
    "August",
    "September",
    "October",
    "November",
    "December"
  ];
  G.daysOfWeek = [
    "Monday",
    "Tuesday",
    "Wednesday",
    "Thursday",
    "Friday",
    "Saturday",
    "Sunday"
  ];

  G.switchStage(DEV_MODE ? "myBinder" : "home");

  //
  //
  //

  // ===================================================

  /**
   * Handles purchasing/renewing/modifying user's plan
   * @param {"Stripe"} stripe
   * @param {{
   *  userId: string,
   *  renewal: boolean,
   *  tier: "tier id NOT _id",
   *  form?: {email: string, firstName: string, lastName: string, address: {
   *    line1: string, city: string, postal_code: string, country: string
   *  }},
   *  length: number,
   *  tokenId?: "Stripe Token ID"
   * }} options
   * @param {boolean} provisionStorage do you want to call /provision ?
   * @param callbacks
   * @returns {Promise<null>} will always return data through callbacks; resolves in all cases
   */
  function purchaseEndpoint(
    stripe,
    { userId, renew, tier, form, length, tokenId, ...extraArgs },
    provisionStorage,
    {
      onDeclined,
      onUpdateError,
      onProvisionError,
      onBeforeProvision,
      onUnknownError,
      onSuccess
    }
  ) {
    return new Promise((resolve, reject) => {
      if (renew && (tier || form || length)) {
        return reject(
          "cannot supply new purchase arguments (tier/form/length) when renewing"
        );
      }
      $http
        .post(
          `${API_DOMAIN}/client/plan/purchase`,
          {
            uid: userId,
            renew,
            tier,
            form,
            length,
            token: tokenId,
            ...extraArgs
          },
          oauthHeader()
        )
        .then(() => updateUserAndPlan())
        .catch(err => {
          if (err.status == 402) {
            err.data = err.data.data;
            if (err.data.status == "requires_payment_method") {
              return resolve(onDeclined);
            } else if (err.data.status == "requires_action") {
              stripe.handleCardPayment(err.data.reattempt).then(result => {
                if (result.error) {
                  // likely invalid authentication
                  delete err.data.reattempt;
                  resolve(() => onDeclined(err));
                } else {
                  updateUserAndPlan(err.data.plan, result);
                }
              });
              return;
            }
            delete err.data.reattempt;
          }
          reject(err);
        });
      function updateUserAndPlan(plan, result) {
        User.findOne({ _id: G.user._id }, { plan: 1 }, (err, user) => {
          if (err) {
            return resolve(() => onUpdateError(err));
          }
          if (!user) {
            return resolve(onUpdateError);
          }
          Plan.updateOne(
            { _id: user.plan },
            {
              active: true,
              "log.activatedDate": result
                ? result.paymentIntent.created || Date.now()
                : Date.now()
            },
            err => {
              if (err) {
                return resolve(() => onUpdateError(err));
              }
              onPaymentSuccess();
            }
          );
        });
      }
      function onPaymentSuccess() {
        if (provisionStorage) {
          onBeforeProvision();
          $http
            .post(
              `${G.API_DOMAIN}/client/plan/provision`,
              {
                uid: G.user._id
              },
              G.oauthHeader()
            )
            .then(() => resolve(onSuccess))
            .catch(err => resolve(() => onProvisionError(err)));
        } else {
          resolve(onSuccess);
        }
      }
    })
      .then(callback => callback())
      .catch(err => onUnknownError(err));
  }
});
