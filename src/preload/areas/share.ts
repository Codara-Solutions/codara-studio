// window.spark.share: the renderer side of src/main/share/ (Share as link).
// The renderer packages the page and hands it over only after the user chose
// Share; it never sees the share key.

import { ipcRenderer } from "electron";

import type {
  ShareCreateInput,
  SharedPage,
  SharedPagesList,
  ShareExpiryDays,
  ShareOffer,
} from "@shared/share";
import type {
  ShareAssetRequest,
  ShareAssetResult,
  ShareRemoteRequest,
  ShareRemoteResult,
} from "@shared/share-assets";

export const shareApi = {
  create: (input: ShareCreateInput): Promise<SharedPage> => ipcRenderer.invoke("share:create", input),
  list: (): Promise<SharedPagesList> => ipcRenderer.invoke("share:list"),
  /** A local file the page embeds; main checks where it really is before reading it. */
  readAsset: (request: ShareAssetRequest): Promise<ShareAssetResult> => ipcRenderer.invoke("share:readAsset", request),
  /** A library, stylesheet or font from an allowed CDN, downloaded by main. */
  fetchRemote: (request: ShareRemoteRequest): Promise<ShareRemoteResult> =>
    ipcRenderer.invoke("share:fetchRemote", request),
  delete: (id: string): Promise<void> => ipcRenderer.invoke("share:delete", id),
  setExpiry: (id: string, ttlDays: ShareExpiryDays): Promise<SharedPage> =>
    ipcRenderer.invoke("share:setExpiry", { id, ttlDays }),
  /** An agent asked to offer sharing a file (codara_share_offer). Only opens the prompt. */
  onOffer: (listener: (offer: ShareOffer) => void): (() => void) => {
    const wrapped = (_event: unknown, payload: ShareOffer): void => {
      if (payload && typeof payload.path === "string") listener({ path: payload.path });
    };
    ipcRenderer.on("share:offer", wrapped);
    return () => ipcRenderer.removeListener("share:offer", wrapped);
  },
};
