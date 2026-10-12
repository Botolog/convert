import type { RequirementsConfig } from "scripts/build/types";

export default [
  {
    name: "wasi-libc",
    url: "https://github.com/WebAssembly/wasi-libc/archive/ac020b86fd44bafe60aa4fa12f407d16e3731329.tar.gz",
    hash: ["sha256", "d44bd7fa456aa42c1494767e5ffa00cdbab182d8497a577592a6562629f6f49e"],
  },
  {
    name: "musl",
    url: "https://musl.libc.org/releases/musl-1.2.6.tar.gz",
    hash: ["sha256", "d585fd3b613c66151fc3249e8ed44f77020cb5e6c1e635a616d3f9f82460512a"],
  },
  {
    name: "kernel-headers",
    url: "https://github.com/sabotage-linux/kernel-headers/archive/eda76135ba1d81d84780af71dcb1b302eb641d39.tar.gz",
    hash: ["sha256", "c482f852298775dd52a53f767bdcceaf1a0dbfba1ad5d249aade1ba52d545459"],
  },
  {
    name: "mingw-w64",
    url: "https://github.com/mingw-w64/mingw-w64/archive/9b3dd0125792fe94d16cacdc596dbd42fca1b369.tar.gz",
    hash: ["sha256", "a538427786ab530b253c8350a9b4c14e511032f8900366336b29065ad23de129"],
  },
] satisfies RequirementsConfig;
