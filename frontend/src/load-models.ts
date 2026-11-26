// Fork: reading .obj and .step files into furniture – its bundle loads only when an admin imports a model.

import type * as ModelsBundle from "./models/entry.ts";

/** Content hash of the models bundle, set by the build (see build.mjs). */
declare const __FP3D_MODELS_HASH__: string;

let loading: Promise<typeof ModelsBundle> | undefined;

export function loadModels(): Promise<typeof ModelsBundle> {
  const url = new URL(`./neonplan3d-models.js?v=${__FP3D_MODELS_HASH__}`, new URL(import.meta.url)).href;
  loading ??= (import(/* @vite-ignore */ url) as Promise<typeof ModelsBundle>).catch((err) => {
    loading = undefined;
    throw err;
  });
  return loading;
}
