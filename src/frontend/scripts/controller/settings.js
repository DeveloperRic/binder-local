// settings ctrl
app.controller("settingsCtrl", function($scope, $rootScope, $interval, $http) {
  const G = $rootScope.G;
  const User = G.clientModels.User;
  const {
    get: getSettings,
    set: updateSettings,
    save: saveSettings
  } = G.require("services/localSettings");
  const { checkAutoLauncher } = G.require("prodVariables");
  const { hideAppWindow, showAppWindow } = G.require(
    "frontend/app/app-process"
  );
  const { createAuthWindow } = G.require("frontend/app/auth-process");

  // ---------------------------------------

  var stage = ($scope.stage = {
    status: "waiting"
  });

  $scope.refreshFrontend = () => {
    window.location.reload();
  };

  var autolaunch = ($scope.autolaunch = {
    status: "waiting",
    enabled: true,
    refresh: () => {
      autolaunch.status = "loading";
      let {
        autolaunch: { enabled }
      } = getSettings();
      autolaunch.enabled = enabled;
      autolaunch.status = "";
    },
    toggle: () => {
      if (autolaunch.status == "updating") return;
      autolaunch.status = "updating";
      if (updateSettings(!autolaunch.enabled, "autolaunch", "enabled")) {
        saveSettings()
          .then(() => {
            autolaunch.refresh();
            autolaunch.status = "updating";
            $scope.$apply();
            setTimeout(() => {
              checkAutoLauncher(autolaunch.enabled)
                .then(() => {
                  autolaunch.status = "";
                  $scope.$apply();
                })
                .catch(err => {
                  G.notifyError("Failed to update autolaunch with the OS", err);
                });
            }, 3000);
          })
          .catch(err => G.notifyError("Failed to toggle autolaunch", err));
      } else {
        G.notifyError(
          "Failed to toggle autolaunch",
          new Error("setting was not set")
        );
      }
    }
  });

  var email = ($scope.email = {
    status: "",
    error: null,
    doneTask: null,
    oldEmailAddress: "-",
    newEmailAddress: "",
    refresh: () => {
      email.oldEmailAddress = G.user.email;
    },
    submitUpdate: () => {
      if (true) return G.notifyError("Not implemented");
      if (email.status == "updating") return;
      email.status = "updating";
      email.error = null;
      $interval.cancel(email.doneTask);
      if (!G.validateEmail(email.newEmailAddress)) {
        G.notifyLoading(false);
        return (email.error = "Email address is in wrong format");
      }
      User.updateOne(
        { _id: G.user._id },
        { email: email.newEmailAddress },
        err => {
          if (err) {
            email.status = "";
            email.error = "Couldn't update your billing info";
          } else {
            email.oldEmailAddress = email.newEmailAddress;
            email.status = "success";
            email.doneTask = $interval(() => (email.status = ""), 4500, 1);
          }
          $scope.$apply();
        }
      );
    }
  });

  var name = ($scope.name = {
    status: "",
    error: null,
    doneTask: null,
    old: {
      firstName: "-",
      lastName: "-"
    },
    new: {
      firstName: "",
      lastName: ""
    },
    refresh: () => {
      try {
        name.old.firstName = G.user.billing.firstName;
        name.old.lastName = G.user.billing.lastName; 
      } catch (err) {
        console.error(err);
      }
    },
    submitUpdate: () => {
      if (name.status == "updating") return;
      name.status = "updating";
      name.error = null;
      $interval.cancel(name.doneTask);
      User.updateOne(
        { _id: G.user._id },
        {
          "billing.firstName": name.new.firstName,
          "billing.lastName": name.new.lastName
        },
        err => {
          if (err) {
            name.status = "";
            name.error = "Couldn't update your name";
          } else {
            name.old = { ...name.new };
            name.status = "success";
            name.doneTask = $interval(() => (name.status = ""), 4500, 1);
          }
          $scope.$apply();
        }
      );
    }
  });

  var address = ($scope.address = {
    status: "",
    error: null,
    doneTask: null,
    oldAddress: "-",
    new: {
      line1: "",
      line2: "",
      city: "",
      postal_code: "",
      country: "Canada"
    },
    refresh: () => {
      try {
        address.oldAddress = Object.values(G.user.billing.address);
      } catch (err) {
        console.error(err);
      }
    },
    submitUpdate: () => {
      if (address.status == "updating") return;
      address.status = "updating";
      address.error = null;
      $interval.cancel(address.doneTask);
      let checkTrimmedContent = obj => {
        for (const key in obj) {
          if (typeof obj[key] == "string") {
            obj[key] = obj[key].trim();
            if (obj[key].length == 0 && key != "line2") {
              return (address.error = { msg: "Some fields are empty" });
            }
          } else if (checkTrimmedContent(obj[key])) {
            return true;
          }
        }
      };
      if (checkTrimmedContent(address.new)) {
        return (address.status = "");
      }
      if (
        !/^[A-Za-z]\d[A-Za-z][ -]?\d[A-Za-z]\d$/.test(address.new.postal_code)
      ) {
        address.status = "";
        return (address.error = {
          cause: "postal-code",
          msg: "Invalid postal code"
        });
      }
      User.updateOne(
        { _id: G.user._id },
        { "billing.address": address.new },
        err => {
          if (err) {
            address.status = "";
            address.error = { msg: "Couldn't update your billing info" };
          } else {
            address.oldAddress = Object.values(address.new);
            address.status = "success";
            address.doneTask = $interval(() => (address.status = ""), 4500, 1);
          }
          $scope.$apply();
        }
      );
    }
  });

  var plan = ($scope.plan = {
    authorize: callback => {
      hideAppWindow();
      createAuthWindow(authorized => {
        showAppWindow();
        callback(authorized);
      });
    },
    cancel: {
      cycle: "unknown",
      submit: () => {
        G.notifyInfo(
          [
            "Are you sure you want to cancel your plan?",
            "You may be asked to login again to confirm this action."
          ],
          false,
          confirmed => {
            if (!confirmed) return;
            G.notifyLoading(true);
            plan.authorize(authorized => {
              if (!authorized) {
                G.notifyLoading(false);
                G.notifyError([
                  "We couldn't verify your credentials.",
                  "Your plan was not cancelled."
                ]);
                $scope.$apply();
              } else {
                $http
                  .post(
                    `${G.API_DOMAIN}/client/plan/cancel`,
                    { uid: G.user._id },
                    G.oauthHeader()
                  )
                  .then(() => G.restart())
                  .catch(err => {
                    G.notifyLoading(false);
                    G.notifyError(
                      "Something went wrong and your plan was not cancelled.",
                      err
                    );
                  });
              }
            });
          },
          true
        );
      }
    },
    reset: {
      submit: () => {
        G.notifyInfo(
          [
            "Are you sure you want to reset your plan data?",
            "You may be asked to login again to confirm this action."
          ],
          false,
          confirmed => {
            if (!confirmed) return;
            G.notifyLoading(true);
            plan.authorize(authorized => {
              if (!authorized) {
                G.notifyLoading(false);
                G.notifyError([
                  "We couldn't verify your credentials.",
                  "Your data was not reset."
                ]);
                $scope.$apply();
              } else {
                $http
                  .post(
                    `${G.API_DOMAIN}/client/plan/resetBlocks`,
                    { uid: G.user._id },
                    G.oauthHeader()
                  )
                  .then(() => G.restart())
                  .catch(err => {
                    G.notifyLoading(false);
                    G.notifyError(
                      "Something went wrong and your data was not reset.",
                      err
                    );
                  });
              }
            });
          },
          true
        );
      }
    },
    delete: {
      submit: () => {
        G.notifyInfo(
          [
            "Are you sure you want to delete your account?",
            "You may be asked to login again to confirm this action."
          ],
          false,
          confirmed => {
            if (!confirmed) return;
            G.notifyLoading(true);
            plan.authorize(authorized => {
              if (!authorized) {
                G.notifyLoading(false);
                G.notifyError([
                  "We couldn't verify your credentials.",
                  "Your account was not deleted."
                ]);
                $scope.$apply();
              } else {
                $http
                  .post(
                    `${G.API_DOMAIN}/client/auth/deleteUser`,
                    { uid: G.user._id },
                    G.oauthHeader()
                  )
                  .then(() => G.restart())
                  .catch(err => {
                    G.notifyLoading(false);
                    G.notifyError(
                      "Something went wrong and your account was not deleted.",
                      err
                    );
                  });
              }
            });
          },
          true
        );
      }
    },
    refresh: () => {
      if (G.user.plan.lengthInMonths == 1) {
        plan.cancel.cycle = "monthly";
      } else if (G.user.plan.lengthInMonths == 4) {
        plan.cancel.cycle = "quaterly";
      } else if (G.user.plan.lengthInMonths == 12) {
        plan.cancel.cycle = "annually";
      }
    }
  });

  // ---------------------------------------

  stage.status = "loading";

  G.getUser(
    (err, user) => {
      if (err || !user) {
        stage.status = "error";
        return G.notifyError("We couldn't get your user info", err);
      }
      G.user = user;
      try {
        autolaunch.refresh();
        email.refresh();
        name.refresh();
        address.refresh();
        if (user.plan) {
          plan.refresh();
        }
        stage.status = "";
      } catch (err) {
        stage.status = "error";
        G.notifyError("We couldn't get your user info", err);
      }
      $scope.$apply();
    },
    "billing",
    "plan.lengthInMonths"
  );
});
