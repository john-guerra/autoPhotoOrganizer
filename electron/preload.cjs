"use strict";

const { contextBridge } = require("electron");

contextBridge.exposeInMainWorld("autogallery", {});
