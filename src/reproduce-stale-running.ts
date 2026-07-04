const child = Bun.spawn([
  "bun",
  "test",
  "test/cli/tui/data.test.tsx",
  "--test-name-pattern",
  "clears stale running status after reconnect",
], {
  cwd: "/root/projects/opencode-latest/packages/tui",
  stdout: "pipe",
  stderr: "pipe",
})

const [status, stdout, stderr] = await Promise.all([
  child.exited,
  new Response(child.stdout).text(),
  new Response(child.stderr).text(),
])
const output = `${stdout}${stderr}`
process.stdout.write(output)

if (status !== 0 && output.includes('Expected: "idle"') && output.includes('Received: "running"')) {
  console.log("\nREPRODUCED: reconnect left an inactive session stuck in the running UI state.")
  process.exit(0)
}

throw new Error(`reproduction did not produce the expected stale-running failure (test exit ${status})`)
