import type { ToolchainsConfig } from "../../scripts/build/types";

export default [
  {
    name: "node",
    url: "https://nodejs.org/dist/v24.19.0/node-v24.19.0-linux-x64.tar.xz",
    hash: ["sha256", "14b342e71204f811bde6153be8e04b62aef63c236fef92b55f9c83154b409647"],
  },
  {
    name: "typescript",
    url: "https://registry.npmjs.org/@typescript/typescript-linux-x64/-/typescript-linux-x64-7.0.2.tgz",
    hash: ["sha256", "7ecad6f67377e831856367ab062ef394f21506a611405bf8ac0ff039348637d3"],
  },
  {
    name: "emscripten",
    url: "https://storage.googleapis.com/webassembly/emscripten-releases-builds/linux/666337b525e673e769121856d175f6f52b8ead64/wasm-binaries.tar.xz",
    hash: ["sha256", "a51dd2829bdf725d268974728e032533b106ea01cb482a62288ec12627a7abbe"],
    toolchains: ["node", "typescript"],
  },
  {
    name: "bun",
    url: "https://github.com/oven-sh/bun/releases/download/bun-v1.4.2/bun-linux-x64.zip",
    hash: ["sha256", "36368faef7527875d5ffa52e53cd48021741f2a83eb6208a8dd64068d422a913"],
  },
] satisfies ToolchainsConfig;
