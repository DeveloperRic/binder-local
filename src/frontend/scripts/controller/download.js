// download ctrl
app.controller("downloadCtrl", function($scope, $rootScope, $http) {
  const nacl = require('tweetnacl');
  nacl.util = require('tweetnacl-util');

  const G = $rootScope.G;

  // ---------------------------------------

  var stage = ($scope.stage = {
    status: "waiting"
  });

  // ---------------------------------------

  stage.status = "loading";

  G.getUser((err, user) => {
    if (err || !user) {
      stage.status = "error";
      return G.notifyError("We couldn't get your user info", err);
    }
    G.user = user;
    if (!user.plan) {
      stage.status = "error";
      G.notifyError("Cannot show info without a plan");
      return $scope.$apply();
    }
    const localPublicKey = nacl.randomBytes(32);
    stage.status = "";
    //TODO change host url
    // $http
    //   .post(
    //     "http://localhost:3000/init/handshake",
    //     {
    //       uid: user._id,
    //       localPublicKey
    //     },
    //     G.oauthHeader()
    //   )
    //   .then(({ data }) => {
    //     let cloudPublicKey = [];
    //     for (let i in data) {
    //       cloudPublicKey.push(data[i]);
    //     }
    //     const sharedKey = nacl.box.before(new Uint8Array(cloudPublicKey), nacl.randomBytes(32))
    //     const nonce = nacl.randomBytes(24)
    //     const box = nacl.box.after(
    //       nacl.util.decodeUTF8("b2 decrypt key"),
    //       nonce,
    //       sharedKey // <-- using shared key
    //     );
    //     console.log(box.length);
    //     $http
    //       .post(
    //         "http://localhost:3000/init/request",
    //         {
    //           uid: user._id,
    //           b2DecryptPackage: {box, nonce},
    //           filesToDownload: ["hi", "hi2"]
    //         },
    //         G.oauthHeader()
    //       )
    //       .then(({data}) => {
    //         console.log(data);
    //       })
    //       .catch(err => G.notifyError("request", err));
    //   })
    //   .catch(err => G.notifyError("handshake", err));
    $scope.$apply();
  });

  function fixPathSlashes(path) {
    return path.replace(new RegExp(G.regexEscape("\\"), "g"), "/");
  }

  function smallerPath(path, estLength) {
    let orgLength = path.length;
    path = path.substr(path.length - estLength, estLength);
    if (path.includes("/")) {
      path = path.substr(path.indexOf("/"));
    } else if (orgLength > estLength) {
      path = "..." + path;
    }
    return path;
  }
});
