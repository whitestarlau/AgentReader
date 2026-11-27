import assert from "node:assert/strict";
import test from "node:test";
import {
	appBundleFromExecPath,
	linuxAppImageTarget,
	macReplaceScript,
	prepareInstall,
	shellQuote,
	windowsInstallerPlan,
} from "./install.ts";

test("locates the .app bundle from the executable path", () => {
	assert.equal(
		appBundleFromExecPath("/Applications/AgentReader.app/Contents/MacOS/AgentReader"),
		"/Applications/AgentReader.app",
	);
	assert.equal(
		appBundleFromExecPath("/Volumes/AgentReader/AgentReader.app/Contents/MacOS/AgentReader"),
		"/Volumes/AgentReader/AgentReader.app",
	);
	assert.equal(appBundleFromExecPath("/usr/local/bin/agentreader"), null);
});

test("shell quoting survives quotes and semicolons", () => {
	assert.equal(shellQuote("/Applications/AgentReader.app"), "'/Applications/AgentReader.app'");
	assert.equal(shellQuote("a'b;rm -rf /"), `'a'\\''b;rm -rf /'`);
	const script = macReplaceScript({
		pid: 42,
		target: "/Applications/Agent'Reader.app",
		staged: "/tmp/stage/AgentReader.app",
		cleanupDir: "/tmp/stage",
		logPath: "/tmp/update.log",
	});
	// 目标路径被整体单引号包住，注入的命令不会被 bash 执行。
	assert.ok(script.includes(`'/Applications/Agent'\\''Reader.app'`));
	assert.ok(script.includes("PID=42"));
	assert.ok(script.includes('kill -0 "$PID"'));
	assert.ok(script.includes("/usr/bin/ditto"));
	assert.ok(script.includes("/usr/bin/open"));
	// 脚本以 shebang 开头并可执行。
	assert.ok(script.startsWith("#!/bin/bash"));
});

test("Windows uses the NSIS silent install and relaunches via --force-run", () => {
	const exe = windowsInstallerPlan("C:\\Users\\me\\Downloads\\AgentReader-Setup-0.4.0.exe");
	assert.equal(exe.mode, "spawn");
	if (exe.mode === "spawn") {
		assert.deepEqual(exe.args, ["/S", "--force-run"]);
		assert.equal(exe.relaunch, false);
	}
	const msi = windowsInstallerPlan("C:\\Downloads\\AgentReader-0.4.0-x64.msi");
	assert.equal(msi.mode, "spawn");
	if (msi.mode === "spawn") assert.equal(msi.command, "msiexec.exe");
	const unknown = windowsInstallerPlan("C:\\Downloads\\notes.txt");
	assert.equal(unknown.mode, "manual");
});

test("Linux replaces the AppImage that is actually running", () => {
	assert.equal(
		linuxAppImageTarget("/tmp/.mount_ar/usr/bin/agentreader", {
			APPIMAGE: "/home/me/Apps/AgentReader-0.3.0.AppImage",
		}),
		"/home/me/Apps/AgentReader-0.3.0.AppImage",
	);
	assert.equal(
		linuxAppImageTarget("/home/me/Apps/AgentReader-0.3.0.AppImage", {}),
		"/home/me/Apps/AgentReader-0.3.0.AppImage",
	);
	assert.equal(linuxAppImageTarget("/usr/bin/agentreader", {}), null);
});

test("unsupported installers and non-mac platforms fall back to manual", async () => {
	const manual = await prepareInstall({
		platform: "linux",
		installerPath: "/tmp/AgentReader-0.4.0-x86_64.deb",
		execPath: "/usr/bin/agentreader",
		pid: 1,
		workDir: "/tmp/ar-update-install",
		logPath: "/tmp/ar-update.log",
		env: {},
	});
	assert.equal(manual.mode, "manual");
	const zip = await prepareInstall({
		platform: "darwin",
		installerPath: "/tmp/AgentReader-0.4.0-arm64.zip",
		execPath: "/Applications/AgentReader.app/Contents/MacOS/AgentReader",
		pid: 1,
		workDir: "/tmp/ar-update-install",
		logPath: "/tmp/ar-update.log",
	});
	assert.equal(zip.mode, "manual");
});
