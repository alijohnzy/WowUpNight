// Benchmarks a released WowUp AppImage (Electron) against a released WowUpNight AppImage
// (Tauri) on Linux, the way a user meets them: launched from the AppImage, with the same addon
// library and the same WoW folders. By default the window opens; --minimized starts both in
// the tray, as they start with the system.
//
//   node scripts/bench-releases.mjs --electron WowUp-2.25.5.AppImage \
//     --tauri WowUpNight_2.25.4.49_amd64.AppImage [--runs 6] [--hold 45000] [--minimized] [--tauri-gpu]
//
// Needs kwin_wayland and dbus-run-session. Each launch gets its own headless KWin (virtual
// output, hardware GL) on a private D-Bus with no service activation, so no window reaches
// the real desktop and neither app can find the real session bus, the real tray or a
// WowUpNight that is already running.
//
// Each app gets one throwaway HOME for the whole benchmark, seeded from the same copy of the
// local WowUpNight profile (both apps read the same store format). Its WoW installations are
// pointed at a copy of their AddOns folders under the work directory, so nothing either app
// does at startup (a sync writing wowup_data_addon, an addon update) touches the real ones.
// The work directory is on disk, not /tmp: /tmp is often RAM-backed, and gigabytes of AddOns
// there would take memory from the apps being measured.
//
// The first launch of each app is a discarded warm-up, and launches alternate, so cache
// warming and thermal drift hit both alike. Caches then persist between launches, as they do
// in daily use.
//
// Timing marks are log lines both renderers print, read from each app's log file as it grows:
//   Language setup start          the renderer is running app code
//   onAutoUpdateInterval          startup finished, the first addon check begins
//   Available update data synced  the first check against the addon sites is done
// They are measured from spawning the AppImage, so they include mounting it. The last one
// depends on the network as much as on the app.
//
// Memory is PSS summed over the app's process tree, not RSS: summing RSS counts every page
// that processes share once per process. Graphics memory is counted separately (see
// gpuBytes) and matters: the two engines put different amounts of their memory there. Idle
// figures cover the last 15 seconds of the hold.

import { spawn, spawnSync } from "node:child_process";
import {
  closeSync,
  copyFileSync,
  cpSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  readlinkSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SELF = fileURLToPath(import.meta.url);
const CLK_TCK = 100;
const IDLE_WINDOW_MS = 15_000;
const MARKS = [
  ["renderer", "Language setup start"],
  ["initialized", "onAutoUpdateInterval"],
  ["synced", "Available update data synced"],
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------------------
// Inside the nested session: launch one app, watch it, stop exactly what it started.
// ---------------------------------------------------------------------------------------

function processes() {
  const out = [];
  for (const name of readdirSync("/proc")) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const stat = readFileSync(`/proc/${name}/stat`, "utf8");
      // comm may contain spaces and parentheses, so fields are counted from the last ')'.
      const f = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      out.push({
        pid: Number(name),
        ppid: Number(f[1]),
        comm: stat.slice(stat.indexOf("(") + 1, stat.lastIndexOf(")")),
        // utime + stime + cutime + cstime: cutime/cstime carry children that already exited.
        ticks: Number(f[11]) + Number(f[12]) + Number(f[13]) + Number(f[14]),
      });
    } catch {
      /* exited while listing */
    }
  }
  return out;
}

function tree(root) {
  const all = processes();
  const pids = new Set([root]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const p of all) {
      if (!pids.has(p.pid) && pids.has(p.ppid)) {
        pids.add(p.pid);
        grew = true;
      }
    }
  }
  return all.filter((p) => pids.has(p.pid));
}

const UNIT = { KiB: 1024, MiB: 1024 ** 2, GiB: 1024 ** 3 };

/**
 * Graphics memory the process tree holds, from the DRM fdinfo of its /dev/dri descriptors.
 * PSS does not see it, and the two engines split their memory differently: Chromium keeps
 * page tiles in GPU buffers, while WebKit drawing without its GPU renderer keeps them in
 * ordinary memory. Leaving this out undercounted Electron by ~180MB. Each DRM client is
 * counted once, however many descriptors or processes share it.
 */
function gpuBytes(procs) {
  const seen = new Set();
  let bytes = 0;
  for (const { pid } of procs) {
    let fds = [];
    try {
      fds = readdirSync(`/proc/${pid}/fd`);
    } catch {
      continue;
    }
    for (const fd of fds) {
      try {
        if (!readlinkSync(`/proc/${pid}/fd/${fd}`).startsWith("/dev/dri/")) continue;
        const info = readFileSync(`/proc/${pid}/fdinfo/${fd}`, "utf8");
        const id = info.match(/^drm-client-id:\s+(\d+)/m)?.[1];
        if (!id || seen.has(id)) continue;
        seen.add(id);
        // drm-resident-<region> is the standard key; older drivers only report drm-memory-<region>.
        const keys = /^drm-resident-/m.test(info)
          ? /^drm-resident-\S+:\s+(\d+)\s*(\w+)?/gm
          : /^drm-memory-\S+:\s+(\d+)\s*(\w+)?/gm;
        for (const m of info.matchAll(keys)) bytes += Number(m[1]) * (UNIT[m[2]] ?? 1);
      } catch {
        /* closed or exited */
      }
    }
  }
  return bytes;
}

function sample(root) {
  const procs = tree(root);
  let pssKb = 0;
  for (const p of procs) {
    try {
      pssKb += Number(readFileSync(`/proc/${p.pid}/smaps_rollup`, "utf8").match(/^Pss:\s+(\d+) kB/m)?.[1] ?? 0);
    } catch {
      /* exited */
    }
  }
  return {
    pssMb: pssKb / 1024,
    gpuMb: gpuBytes(procs) / 1024 ** 2,
    procs: procs.length,
    comms: procs.map((p) => p.comm),
    ticks: procs.reduce((s, p) => s + p.ticks, 0),
  };
}

async function measure([app, appArgs, logFile, holdMs, outFile, stdoutFile]) {
  const hold = Number(holdMs);
  const out = openSync(stdoutFile, "w");
  const t0 = performance.now();
  const ms = () => Math.round(performance.now() - t0);
  const child = spawn(app, JSON.parse(appArgs), { stdio: ["ignore", out, out] });
  let exitedAt;
  child.on("exit", () => (exitedAt ??= ms()));

  const marks = {};
  let offset = 0;
  let partial = "";
  const readLog = () => {
    if (!existsSync(logFile)) return;
    const size = statSync(logFile).size;
    if (size <= offset) return;
    const fd = openSync(logFile, "r");
    const buf = Buffer.alloc(size - offset);
    readSync(fd, buf, 0, buf.length, offset);
    closeSync(fd);
    offset = size;
    const lines = (partial + buf.toString("utf8")).split("\n");
    partial = lines.pop();
    for (const line of lines)
      for (const [key, text] of MARKS) if (marks[key] === undefined && line.includes(text)) marks[key] = ms();
  };

  const samples = [];
  for (let next = 0; ms() < hold && exitedAt === undefined; await sleep(25)) {
    readLog();
    if (ms() >= next) {
      samples.push({ t: ms(), ...sample(child.pid) });
      next += 1000;
    }
  }
  readLog();

  const last = samples.at(-1);
  const idleFrom = samples.findLast((s) => s.t <= last.t - IDLE_WINDOW_MS);
  const settled = (key) => {
    const tail = samples
      .slice(-5)
      .map((s) => s[key])
      .sort((a, b) => a - b);
    return tail[tail.length >> 1];
  };
  const result = {
    exitedEarly: exitedAt !== undefined,
    marks,
    peakPssMb: Math.max(...samples.map((s) => s.pssMb)),
    idlePssMb: settled("pssMb"),
    idleGpuMb: settled("gpuMb"),
    procs: last.procs,
    processNames: Object.fromEntries(
      [...new Set(last.comms)].map((c) => [c, last.comms.filter((x) => x === c).length]),
    ),
    cpuS: last.ticks / CLK_TCK,
    idleCpuPct: idleFrom ? ((last.ticks - idleFrom.ticks) / CLK_TCK / ((last.t - idleFrom.t) / 1000)) * 100 : null,
    samples: samples.map(({ comms, ...rest }) => rest),
  };

  const victims = tree(child.pid).map((p) => p.pid);
  try {
    process.kill(child.pid, "SIGTERM");
  } catch {
    /* already gone */
  }
  for (let i = 0; i < 50 && victims.some((p) => existsSync(`/proc/${p}`)); i++) await sleep(100);
  for (const p of victims) {
    try {
      process.kill(p, "SIGKILL");
    } catch {
      /* already gone */
    }
  }
  writeFileSync(outFile, JSON.stringify(result, null, 2));
}

// ---------------------------------------------------------------------------------------
// Outside: seed the profiles, run the launches, summarise.
// ---------------------------------------------------------------------------------------

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i === -1 ? fallback : process.argv[i + 1];
}

/** Copies what the apps read of each installation and returns the installations, relocated. */
function copyWow(installations, dest) {
  return installations.map((inst, n) => {
    const clientDir = dirname(inst.location);
    const target = join(dest, String(n), basename(dirname(clientDir)), basename(clientDir));
    if (!existsSync(target)) {
      mkdirSync(join(target, "Interface"), { recursive: true });
      // Client detection reads these beside the client folders.
      for (const f of [".build.info", ".product.db"]) {
        const from = join(dirname(clientDir), f);
        if (existsSync(from)) copyFileSync(from, join(dirname(target), f));
      }
      // The executable is only checked for, never written: a hard link saves copying it.
      if (existsSync(inst.location)) {
        try {
          linkSync(inst.location, join(target, basename(inst.location)));
        } catch {
          copyFileSync(inst.location, join(target, basename(inst.location)));
        }
      }
      // A real copy, not links: the apps rewrite files such as wowup_data_addon/data.lua in place.
      const addons = join(clientDir, "Interface", "AddOns");
      if (existsSync(addons)) cpSync(addons, join(target, "Interface", "AddOns"), { recursive: true });
    }
    return { ...inst, location: join(target, basename(inst.location)) };
  });
}

function seed(app, work, source, installations, minimized) {
  const home = join(work, "homes", app.id);
  rmSync(home, { recursive: true, force: true });
  for (const d of [".config", ".local/share", ".local/state", ".cache"]) mkdirSync(join(home, d), { recursive: true });
  const data = app.dataDir(home);
  mkdirSync(data, { recursive: true });

  const prefs = JSON.parse(readFileSync(join(source, "preferences.json"), "utf8"));
  prefs.wow_installations = typeof prefs.wow_installations === "string" ? JSON.stringify(installations) : installations;
  // Open the window, as launching it from the menu would, or start in the tray with --minimized.
  // The setting alone is not enough for WowUp, which only starts hidden when also passed
  // --hidden, as its login item does; see launch().
  prefs.start_minimized = String(minimized);
  prefs.wago_prompt = true; // the Electron build otherwise opens with a question
  writeFileSync(join(data, "preferences.json"), JSON.stringify(prefs, null, 2));
  for (const f of ["addons.json", "sensitive.json"])
    if (existsSync(join(source, f))) copyFileSync(join(source, f), join(data, f));
  // WowUpNight would otherwise look for a WowUp install to import on its first start.
  if (app.id.startsWith("tauri")) writeFileSync(join(data, ".electron-import-done"), "seeded by bench-releases\n");
  return home;
}

function launch(app, home, work, hold, tag, minimized) {
  // Kept short: Wayland socket paths are limited to 108 bytes.
  const rt = mkdtempSync(join(tmpdir(), "wowup-bench-"));
  const conf = join(rt, "dbus.conf");
  writeFileSync(
    conf,
    readFileSync("/usr/share/dbus-1/session.conf", "utf8").replace(
      /^.*<(standard_session_servicedirs|servicedir|servicehelper)\b.*$/gm,
      "",
    ),
  );
  const outJson = join(rt, "result.json");
  rmSync(app.log(home), { force: true }); // marks must come from this launch only

  const env = { ...process.env };
  for (const k of [
    "APPIMAGE",
    "APPDIR",
    "ARGV0",
    "OWD",
    "DBUS_SESSION_BUS_ADDRESS",
    "WAYLAND_DISPLAY",
    "DISPLAY",
    "XAUTHORITY",
    "ELECTRON_RUN_AS_NODE",
    "SESSION_MANAGER",
  ])
    delete env[k];
  Object.assign(env, {
    HOME: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_DATA_HOME: join(home, ".local/share"),
    XDG_STATE_HOME: join(home, ".local/state"),
    XDG_CACHE_HOME: join(home, ".cache"),
    XDG_RUNTIME_DIR: rt,
    ...app.env,
  });

  const session = join(rt, "session.sh");
  // --minimized launches both the way starting with the system does: with --hidden.
  const measureArgs = [
    app.path,
    JSON.stringify(minimized ? ["--hidden"] : []),
    app.log(home),
    String(hold),
    outJson,
    join(work, "logs", `${app.id}-${tag}.out`),
  ];
  writeFileSync(
    session,
    `#!/bin/sh\nexec ${[process.execPath, SELF, "--measure", ...measureArgs].map((s) => JSON.stringify(s)).join(" ")}\n`,
    { mode: 0o755 },
  );
  // prettier-ignore
  spawnSync("timeout", [
    "-k", "5", String(Math.ceil(hold / 1000) + 60),
    "dbus-run-session", `--config-file=${conf}`, "--",
    "kwin_wayland", "--virtual", "--xwayland", "--socket", "wl0", "--no-lockscreen",
    "--width", "1920", "--height", "1080", "--exit-with-session", session,
  ], { env, cwd: rt, stdio: "ignore" });

  let result;
  try {
    result = JSON.parse(readFileSync(outJson, "utf8"));
  } catch {
    result = { failed: true };
  }
  writeFileSync(join(work, "logs", `${app.id}-${tag}.json`), JSON.stringify(result, null, 2));
  if (existsSync(app.log(home))) copyFileSync(app.log(home), join(work, "logs", `${app.id}-${tag}.log`));
  rmSync(rt, { recursive: true, force: true });
  return result;
}

const median = (xs) => {
  const v = xs.filter(Number.isFinite).sort((a, b) => a - b);
  if (!v.length) return NaN;
  const m = v.length >> 1;
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
};

async function main() {
  const electron = arg("--electron");
  const tauri = arg("--tauri");
  if (!electron || !tauri) {
    console.error("usage: bench-releases.mjs --electron <WowUp AppImage> --tauri <WowUpNight AppImage>");
    process.exit(1);
  }
  const runs = Number(arg("--runs", 6));
  const hold = Number(arg("--hold", 45_000));
  const work = resolve(arg("--work", join(homedir(), ".cache", "wowup-bench")));
  const source = resolve(arg("--profile", join(homedir(), ".local/share/io.wowupcf.tauri")));
  const minimized = process.argv.includes("--minimized");
  const tauriData = (h) => join(h, ".local/share/io.wowupcf.tauri");

  const apps = [
    {
      id: "electron",
      path: resolve(electron),
      dataDir: (h) => join(h, ".config/WowUp"),
      log: (h) => join(h, ".config/WowUp/logs/main.log"),
    },
    {
      id: "tauri",
      path: resolve(tauri),
      dataDir: tauriData,
      log: (h) => join(tauriData(h), "logs/WowUpNight.log"),
    },
  ];
  // The AppImage turns WebKit's GPU (DMABUF) renderer off, since it came up blank there
  // (src-tauri/src/lib.rs); the .deb keeps it. --tauri-gpu adds the same AppImage with the
  // renderer left on, which is how the .deb draws. A value set beforehand is respected by
  // the app, and WebKit reads "0" as "not disabled".
  if (process.argv.includes("--tauri-gpu"))
    apps.push({ ...apps[1], id: "tauri-gpu", env: { WEBKIT_DISABLE_DMABUF_RENDERER: "0" } });

  const raw = JSON.parse(readFileSync(join(source, "preferences.json"), "utf8")).wow_installations ?? [];
  const installations = copyWow(typeof raw === "string" ? JSON.parse(raw) : raw, join(work, "wow"));
  rmSync(join(work, "logs"), { recursive: true, force: true });
  mkdirSync(join(work, "logs"), { recursive: true });
  const homes = Object.fromEntries(apps.map((a) => [a.id, seed(a, work, source, installations, minimized)]));
  const results = Object.fromEntries(apps.map((a) => [a.id, []]));

  for (let i = 0; i <= runs; i++) {
    for (const app of apps) {
      const tag = i === 0 ? "warmup" : `run${i}`;
      const r = launch(app, homes[app.id], work, hold, tag, minimized);
      const m = r.marks ?? {};
      console.log(
        `${app.id.padEnd(9)} ${tag.padEnd(7)} renderer=${m.renderer ?? "—"}ms initialized=${m.initialized ?? "—"}ms ` +
          `synced=${m.synced ?? "—"}ms peak=${Math.round(r.peakPssMb)}MB idle=${Math.round(r.idlePssMb)}MB gpu=${Math.round(r.idleGpuMb)}MB ` +
          `procs=${r.procs} cpu=${r.cpuS?.toFixed(1)}s idleCpu=${r.idleCpuPct?.toFixed(2)}%` +
          (r.failed ? "  FAILED" : r.exitedEarly ? "  EXITED EARLY" : ""),
      );
      if (i > 0 && !r.failed && !r.exitedEarly) results[app.id].push(r);
    }
  }

  const rows = [
    ["App code running", (r) => r.marks.renderer, "ms"],
    ["Startup finished", (r) => r.marks.initialized, "ms"],
    ["First addon check done", (r) => r.marks.synced, "ms"],
    ["Memory, peak (PSS)", (r) => r.peakPssMb, "MB"],
    ["Memory, idle (PSS)", (r) => r.idlePssMb, "MB"],
    ["Graphics memory, idle", (r) => r.idleGpuMb, "MB"],
    ["Memory + graphics, idle", (r) => r.idlePssMb + r.idleGpuMb, "MB"],
    ["Processes", (r) => r.procs, ""],
    ["CPU time over the hold", (r) => r.cpuS, "s"],
    ["CPU while idle, % of a core", (r) => r.idleCpuPct, "%"],
  ];
  console.log(
    `\nmedians of ${runs} launches each, ${hold / 1000}s hold, ${minimized ? "started in the tray" : "window open"}\n`,
  );
  console.log("".padEnd(30) + apps.map((a) => a.id.padStart(12)).join(""));
  const f = (n, unit) => (Number.isFinite(n) ? `${n < 10 ? n.toFixed(2) : Math.round(n)}${unit}` : "—");
  for (const [label, get, unit] of rows)
    console.log(label.padEnd(30) + apps.map((a) => f(median(results[a.id].map(get)), unit).padStart(12)).join(""));
  writeFileSync(
    join(work, "logs", "summary.json"),
    JSON.stringify(
      Object.fromEntries(
        apps.map((a) => [a.id, Object.fromEntries(rows.map(([l, get]) => [l, median(results[a.id].map(get))]))]),
      ),
      null,
      2,
    ),
  );
  console.log(`\nper-launch details in ${join(work, "logs")}`);
}

if (process.argv[2] === "--measure") await measure(process.argv.slice(3));
else await main();
