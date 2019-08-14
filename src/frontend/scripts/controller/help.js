// help ctrl
app.controller("helpCtrl", function($scope, $rootScope, $http) {
  const G = $rootScope.G;

  // ---------------------------------------

  var stage = ($scope.stage = {
    status: "waiting"
  });

  var guides = ($scope.guides = [
    {
      name: "Purchasing a plan",
      stage: "helpPlan"
    },
    {
      name: "Setting backup folders",
      stage: "helpFolders"
    },
    {
      name: "Controlling archive schedule",
      stage: "helpSchedule"
    },
    {
      name: "Managing your Binder",
      stage: "helpBinder"
    }
  ]);

  var faqs = ($scope.faqs = []);

  // ---------------------------------------

  stage.status = "loading";

  G.getUser((err, user) => {
    if (err || !user) {
      stage.status = "error";
      return G.notifyError("We couldn't get your user info", err);
    }
    G.user = user;
    stage.status = "";
    $scope.$apply();
  });
});
