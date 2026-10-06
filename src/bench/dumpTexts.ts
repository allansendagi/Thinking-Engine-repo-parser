#!/usr/bin/env bun
/** Every distinct thought text the miners see (`said`) in the standard bench suite, as a JSON array -- the input for
 *  embedding them with Apple's on-device model (macos-app BenchVectorsTests). */
import { standardSuite } from "./generate";
console.log(JSON.stringify([...new Set(standardSuite().flatMap((s) => s.thoughts.map((t) => t.said)))].sort()));
