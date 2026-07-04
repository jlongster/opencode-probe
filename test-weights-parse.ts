import { parseEnabledTools } from "./src/flows/weights.js"

const args = ["--tools=read"]
const result = parseEnabledTools(args)
console.log("parsed tools:", result)
console.log("size:", result?.size)
console.log("has read:", result?.has("read"))
