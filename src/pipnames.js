// Which pip package provides an import (no Node here: the output card uses it on iPhone too).

// import name -> pip name, where they differ
const PIP_NAMES = {
  cv2: "opencv-python",
  sklearn: "scikit-learn",
  skimage: "scikit-image",
  PIL: "Pillow",
  yaml: "PyYAML",
  bs4: "beautifulsoup4",
  dateutil: "python-dateutil",
  dotenv: "python-dotenv",
  jwt: "PyJWT",
  serial: "pyserial",
  usb: "pyusb",
  Crypto: "pycryptodome",
  google: "protobuf",
  attr: "attrs",
  mpl_toolkits: "matplotlib",
  OpenGL: "PyOpenGL",
  wx: "wxPython",
  gym: "gymnasium",
  pybullet_envs: "pybullet",
  rclpy: null, // ROS 2, not on PyPI
  roslib: null,
};

// "No module named 'cv2'" -> "cv2"
function missingModule(text) {
  const m = /(?:ModuleNotFoundError|ImportError): No module named '([\w.]+)'/.exec(text || "");
  return m ? m[1] : null;
}

function pipNameFor(module) {
  const top = module.split(".")[0];
  return Object.prototype.hasOwnProperty.call(PIP_NAMES, top) ? PIP_NAMES[top] : top;
}

export { missingModule, pipNameFor, PIP_NAMES };
