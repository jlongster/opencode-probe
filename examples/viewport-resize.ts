import { defineScript, wait } from "opencode-drive"

export default defineScript({
  viewport: { cols: 120, rows: 36 },

  async setup({ fs }) {
    await fs.writeFile(
      "src/viewport.ts",
      `export const viewportSequence = ["120x36", "80x24", "50x18"]\n`,
    )
  },

  async run({ ui, llm }) {
    await ui.submit("Show a compact status report for the viewport resize demo.")
    await llm.send(
      llm.text(
        "Viewport demo: starting wide at 120 columns by 36 rows. The file src/viewport.ts lists the planned sequence. This first response should have plenty of horizontal room before the terminal narrows.",
      ),
    )
    await wait(900)

    await ui.resize({ cols: 80, rows: 24 })
    await wait(900)

    await ui.submit("Now describe the medium viewport.")
    await llm.send(
      llm.text(
        "Medium viewport: resized to 80 columns by 24 rows. Lines should wrap sooner, the composer has less vertical breathing room, and the conversation should reflow without losing focus.",
      ),
    )
    await ui.waitFor("resized to 80 columns")
    await wait(900)

    await ui.resize({ cols: 50, rows: 18 })
    await wait(900)

    await ui.submit("Finish with the narrow viewport summary.")
    await llm.send(
      llm.text(
        "Narrow viewport: now 50 columns by 18 rows. This final state is intentionally cramped so modal, wrapping, and footer behavior are easy to inspect in the recording.",
      ),
    )
    await ui.waitFor("now 50 columns")
    await wait(1200)
  },
})
