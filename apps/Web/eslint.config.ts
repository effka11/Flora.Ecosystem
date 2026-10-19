import next from "eslint-config-next";
import type { Linter } from "eslint";

const config: Linter.Config[] = [
  ...next,
  {
    // eslint-config-next 16.4 enables the React Compiler rules from
    // eslint-plugin-react-hooks 7 as errors. The Web app predates the compiler
    // migration; keep the diagnostics visible as warnings until the hooks
    // refactor lands instead of breaking the lint gate.
    rules: {
      "react-hooks/set-state-in-effect": "warn",
      "react-hooks/refs": "warn",
      "react-hooks/preserve-manual-memoization": "warn",
      "react-hooks/immutability": "warn",
    },
  },
];

export default config;
