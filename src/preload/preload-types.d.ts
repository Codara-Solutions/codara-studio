import type { SparkApi } from "./index";

declare global {
  interface Window {
    spark: SparkApi;
  }
}

export {};
