#!/usr/bin/env node
/**
 * Pre-install sanity check for node-pty native compilation prerequisites.
 * node-pty needs a C++ toolchain and Python to build from source when a
 * prebuilt binary is unavailable.
 */
import { execFileSync } from "node:child_process";

function has(tool) {
  try {
    execFileSync("which", [tool], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

if (process.platform === "win32") {
  // Do not block Windows; node-pty may use ConPTY/winpty.
  process.exit(0);
}

const missing = [];
if (!has("python3") && !has("python")) missing.push("python3");
if (!has("make")) missing.push("make");
if (!has("g++") && !has("c++")) missing.push("g++ / build-essential");

if (missing.length > 0) {
  console.error(
    `[devin-remote] node-pty cannot be built: missing native compilation dependencies: ${missing.join(", ")}`,
  );
  console.error(`[devin-remote] Install them first, e.g.`);
  console.error(`  Debian/Ubuntu: sudo apt-get install -y build-essential python3`);
  console.error(`  RHEL/CentOS/Fedora: sudo dnf install -y gcc-c++ make python3`);
  process.exit(1);
}

process.exit(0);
