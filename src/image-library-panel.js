// Accessible image-library boundary C. See ui/README.md for the frozen injection and async contract.
import { IMAGE_ASSET_LIMITS, normalizeImageAssetDraft, validateResolvedImageAsset, normalizeImageLibraryMetadata, imageLibraryMetadata } from "./image-asset-schema.js";
import { searchImageLibrary } from "./image-library.js";
import { decodeLocalPng } from "./image-library-client.js";
let sequence = 0;
const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== void 0) node.textContent = text;
  return node;
};
const scopeOf = (ctx) => JSON.stringify([ctx?.accountId ?? null, ctx?.roomId ?? null, ctx?.roomEpoch ?? null]);
const ownerOf = (ctx) => JSON.stringify([ctx?.accountId ?? null, ctx?.roomId ?? null]);
const context = (get) => {
  const ctx = get() || {};
  if (Object.values(ctx.capabilities || {}).some(Boolean) && (typeof ctx.roomId !== "string" || !ctx.roomId || typeof ctx.accountId !== "string" || !ctx.accountId || !["string", "number"].includes(typeof ctx.roomEpoch))) throw new TypeError("An enabled library requires roomId, accountId and roomEpoch");
  return { roomId: ctx.roomId, roomEpoch: ctx.roomEpoch, accountId: ctx.accountId, capabilities: { ...ctx.capabilities } };
};
function mountImageLibrary({ root, getContext, service, decodePreview = decodeLocalPng, onChoose, onStatus = () => {
}, icon = null }) {
  if (!root || typeof getContext !== "function" || typeof onChoose !== "function") throw new TypeError("root, getContext and onChoose are required");
  for (const method of ["list", "create", "readImage", "reconcileCreate"]) if (typeof service?.[method] !== "function") throw new TypeError(`service.${method} is required`);
  const uid = `image-library-${++sequence}`;
  let ctx = context(getContext), scope = scopeOf(ctx), disposed = false, open = false, returnFocus = null;
  let entries = [], listEpoch = 0, decodeEpoch = 0, preview = null, file = null, grid = null, draftVisible = false, submitting = false, composing = false;
  let listController = null, decodeController = null, uploadController = null, listReady = false;
  const pendingByOwner = /* @__PURE__ */ new Map(), thumbURLs = /* @__PURE__ */ new Set(), thumbControllers = /* @__PURE__ */ new Set();
  let pending = null, editing = null, managementBusy = false, managementConflict = false, managementEpoch = 0, managementController = null;
  root.classList.add("u-image-library");
  root.hidden = true;
  root.setAttribute("role", "region");
  root.setAttribute("aria-label", "Custom image library");
  const header = el("header", "uil-header"), title = el("h2", null, "Custom");
  const button = (text, glyph, cls = "") => {
    const b = el("button", cls);
    b.type = "button";
    if (glyph && icon) {
      const span = el("span", "uil-icon");
      span.innerHTML = icon(glyph);
      span.setAttribute("aria-hidden", "true");
      b.append(span);
    }
    b.append(el("span", null, text));
    return b;
  };
  const close = button("Close library", "Close", "uil-close");
  close.setAttribute("aria-label", "Close Custom image library");
  header.append(title, close);
  const status = el("p", "uil-status");
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");
  status.setAttribute("aria-atomic", "true");
  const permission = el("p", "uil-note");
  const libraryView = el("section", "uil-library");
  const controls = el("div", "uil-tools");
  const searchLabel = el("label", "uil-search");
  searchLabel.append(el("span", null, "Search names, descriptions or tags"));
  const search = el("input");
  search.type = "search";
  search.placeholder = "Search Custom";
  search.autocomplete = "off";
  searchLabel.append(search);
  const add = button("Add PNG", "Plus", "uil-primary"), reload = button("Refresh", null);
  const statusLabel = el("label", "uil-field"), libraryStatus = el("select");
  statusLabel.append(el("span", null, "Library status"), libraryStatus);
  libraryStatus.setAttribute("aria-label", "Library status");
  for (const [value, label] of [["active", "Active images"], ["archived", "Archived images"]]) { const option = el("option", null, label); option.value = value; libraryStatus.append(option); }
  controls.append(searchLabel, statusLabel, add, reload);
  const listStatus = el("p", "uil-empty");
  listStatus.setAttribute("role", "status");
  const cards = el("ul", "uil-cards");
  cards.setAttribute("aria-label", "Custom image objects");
  const lifecycle = el("p", "uil-note", "Edit library names, descriptions and tags, or archive images reversibly. Existing placed versions keep their original image and collision cells.");
  libraryView.append(controls, listStatus, cards, lifecycle);
  const form = el("form", "uil-draft");
  form.hidden = true;
  form.noValidate = true;
  const formTitle = el("h3", null, "New image object");
  formTitle.tabIndex = -1;
  const intro = el("p", "uil-note", "A PNG becomes a flat floor decal or an upright textured panel. Your file stays on this device until you press Upload.");
  const drop = el("div", "uil-drop");
  drop.setAttribute("aria-label", "PNG drop zone");
  const chooser = button("Choose PNG", "Plus");
  const fileInput = el("input", "uil-file");
  fileInput.type = "file";
  fileInput.accept = "image/png,.png";
  fileInput.tabIndex = -1;
  fileInput.setAttribute("aria-label", "Choose PNG image file");
  drop.append(chooser, el("p", null, "or drop one PNG here \xB7 up to 5 MiB \xB7 2048 px per side"), fileInput);
  const previewBox = el("div", "uil-preview");
  previewBox.hidden = true;
  const previewImage = el("img");
  previewImage.alt = "Local image preview";
  const dimensions = el("p", "uil-note");
  previewBox.append(previewImage, dimensions);
  const fields = el("fieldset", "uil-fields");
  const legend = el("legend", null, "Configure image object");
  fields.append(legend);
  function field(labelText, control, key, help) {
    const label = el("label", "uil-field");
    control.id = `${uid}-${key}`;
    label.htmlFor = control.id;
    const caption = el("span", null, labelText);
    caption.id = `${control.id}-label`;
    control.setAttribute("aria-labelledby", caption.id);
    label.append(caption, control);
    if (help) {
      const p = el("small", null, help);
      p.id = `${control.id}-help`;
      control.setAttribute("aria-describedby", p.id);
      label.append(p);
    }
    fields.append(label);
    return control;
  }
  const name = field("Name", el("input"), "name");
  name.required = true;
  name.maxLength = 240;
  name.autocomplete = "off";
  const tags = field("Tags", el("input"), "tags", "Separate tags with commas. Up to 20 tags.");
  tags.autocomplete = "off";
  const depth = field("Representation and depth", el("select"), "depth");
  for (const [value, text] of [["standing", "Upright panel \xB7 standing"], ["floor", "Floor decal \xB7 on the floor"], ["custom", "Upright panel \xB7 custom depth"]]) {
    const o = el("option", null, text);
    o.value = value;
    depth.append(o);
  }
  const pivot = field("Custom ground pivot", el("input"), "pivot", "0 is the image top; 1 is the image bottom. This positions a flat panel, not mesh thickness.");
  pivot.type = "number";
  pivot.min = "0";
  pivot.max = "1";
  pivot.step = "0.01";
  pivot.value = "1";
  pivot.parentElement.hidden = true;
  const floating = el("input");
  floating.type = "checkbox";
  floating.checked = true;
  field("Floating placement", floating, "floating", "Free ground-plane placement, without collision cells. This does not lift the image into the air.");
  const collisions = el("input");
  collisions.type = "checkbox";
  field("Paint collision cells", collisions, "collisions", "Only selected 32 \xD7 32 pixel cells block movement. Transparent pixels do not decide collision.");
  const gridWrap = el("div", "uil-grid-wrap");
  gridWrap.hidden = true;
  const gridNote = el("p", "uil-note", "Use arrow keys to move between cells and Space to toggle. The full image still counts for edit-area boundaries.");
  const gridTable = el("div", "uil-grid");
  gridTable.setAttribute("role", "group");
  gridTable.setAttribute("aria-label", "Collision cells");
  gridWrap.append(gridNote, gridTable);
  fields.append(gridWrap);
  const errorBox = el("p", "uil-error");
  errorBox.id = `uid-error-${uid}`;
  errorBox.setAttribute("role", "alert");
  errorBox.hidden = true;
  const recovery = el("div", "uil-recovery");
  recovery.hidden = true;
  const checkUpload = button("Check upload status", null), retry = button("Retry same upload", null);
  retry.hidden = true;
  recovery.append(checkUpload, retry);
  const actions = el("div", "uil-actions");
  const cancel = button("Cancel draft", null), upload = button("Upload", "Save", "uil-primary");
  upload.type = "submit";
  actions.append(cancel, upload);
  form.append(formTitle, intro, drop, previewBox, fields, errorBox, recovery, actions);
  const management = el("form", "uil-draft"); management.hidden = true; management.noValidate = true;
  const managementTitle = el("h3", null, "Edit image details"); managementTitle.tabIndex = -1;
  const managementNote = el("p", "uil-note"), managementFields = el("fieldset", "uil-fields");
  const detailName = el("input"), detailTags = el("input"), description = el("textarea"); detailName.maxLength = 240; description.maxLength = 4000; description.rows = 4;
  for (const [labelText, input, key] of [["Asset name", detailName, "detail-name"], ["Description", description, "description"], ["Asset tags", detailTags, "detail-tags"]]) {
    const label = el("label", "uil-field"); input.id = `${uid}-${key}`; label.htmlFor = input.id; label.append(el("span", null, labelText), input); managementFields.append(label);
  }
  const managementError = el("p", "uil-error"); managementError.setAttribute("role", "alert"); managementError.hidden = true;
  const latest = button("Load latest details", null); latest.hidden = true;
  const managementActions = el("div", "uil-actions"), cancelManagement = button("Cancel details", null), commitManagement = button("Save details", null, "uil-primary"); commitManagement.type = "submit";
  managementActions.append(cancelManagement, commitManagement); management.append(managementTitle, managementNote, managementFields, managementError, latest, managementActions);
  root.replaceChildren(header, permission, status, libraryView, form, management);
  function hideManagement({focus = true} = {}) {
    editing = null; management.hidden = true; managementBusy = false; managementConflict = false;
    libraryView.hidden = false; managementError.hidden = true; latest.hidden = true;
    if (focus && open) search.focus(); gate();
  }
  function showManagement(entry, action = "metadata") {
    if (!sync() || !ctx.capabilities.canManage || managementBusy) return;
    editing = {entry, action}; managementConflict = false; managementError.hidden = true; latest.hidden = true;
    const metadata = imageLibraryMetadata(entry); detailName.value = metadata.name; description.value = metadata.description; detailTags.value = metadata.tags.join(", ");
    managementFields.hidden = action !== "metadata";
    managementTitle.textContent = action === "metadata" ? "Edit image details" : `Archive ${metadata.name}?`;
    managementNote.textContent = action === "metadata" ? "Changes update discovery text only. Placed names, image bytes, size, depth and collision cells stay unchanged." : "This removes the image from new placement and duplication. Existing placements stay visible and editable. You can restore it from Archived images. After a placement is removed and saved, Undo cannot bring it back until the asset is restored.";
    commitManagement.textContent = action === "metadata" ? "Save details" : "Confirm archive";
    cancelManagement.textContent = action === "metadata" ? "Cancel details" : "Cancel archive";
    management.hidden = false; libraryView.hidden = true; form.hidden = true; managementTitle.focus(); gate();
  }
  async function mutateAsset(entry, change, action) {
    if (!sync() || !ctx.capabilities.canManage || managementBusy) return;
    const captured = scope, epoch = ++managementEpoch; managementBusy = true; managementController = new AbortController(); gate();
    try {
      const result = validEntry(await service.update({roomId: ctx.roomId, assetId: entry.definition.assetId, expectedRevision: entry.revision || 1, ...change, signal: managementController.signal}), true);
      if (!isCurrent(captured, "canManage") || epoch !== managementEpoch) return;
      const name = imageLibraryMetadata(result).name; hideManagement();
      announce(action === "metadata" ? `Saved details for ${name}. Placed versions are unchanged.` : action === "archive" ? `Archived ${name}. Existing placements are unchanged.` : `Restored ${name}. It is available for new placement.`);
      await refresh();
    } catch (error) {
      if (!isCurrent(captured, "canManage") || epoch !== managementEpoch) return;
      if (!editing) { editing = {entry, action: "restore"}; management.hidden = false; libraryView.hidden = true; managementTitle.textContent = "Restore image"; managementFields.hidden = true; managementNote.textContent = "Reload the latest image details before trying again."; cancelManagement.textContent = "Back to library"; }
      managementConflict = true;
      managementError.textContent = error.status === 409 ? "This image changed while you were editing. Your draft is preserved. Load latest details before making another change." : `The change could not be confirmed. ${error.message || "Refresh to check its current state."} Load latest details before trying again.`;
      managementError.hidden = false; latest.hidden = false; managementError.tabIndex = -1; managementError.focus();
    } finally { if (isCurrent(captured) && epoch === managementEpoch) { managementBusy = false; gate(); } }
  }
  management.onsubmit = event => {
    event.preventDefault(); if (composing || !editing || managementConflict || managementBusy) return;
    const {entry, action} = editing;
    try { const change = action === "metadata" ? {metadata: normalizeImageLibraryMetadata({name: detailName.value, description: description.value, tags: detailTags.value})} : {status: "archived"}; mutateAsset(entry, change, action); }
    catch (error) { managementError.textContent = error.message; managementError.hidden = false; }
  };
  cancelManagement.onclick = () => { if (!managementBusy) hideManagement(); };
  latest.onclick = async () => {
    if (!sync() || !editing || managementBusy || !ctx.capabilities.canManage) return;
    const captured = scope, selected = editing, epoch = ++managementEpoch; managementBusy = true; gate();
    try {
      const results = await Promise.all(["active", "archived"].map(status => service.list({roomId: ctx.roomId, query: "", status})));
      if (!isCurrent(captured, "canManage") || editing !== selected || epoch !== managementEpoch) return;
      const current = results.flatMap(result => result.entries).find(entry => entry.definition.assetId === selected.entry.definition.assetId);
      if (!current) throw new Error("This image is no longer available in this room");
      managementBusy = false;
      if (selected.action === "metadata") showManagement(current, "metadata");
      else { hideManagement(); libraryStatus.value = current.status; await refresh(); announce("Latest image status loaded. Choose the action again to confirm it."); }
    } catch (error) { if (isCurrent(captured) && epoch === managementEpoch) { managementError.textContent = error.message; managementError.hidden = false; } }
    finally { if (isCurrent(captured) && epoch === managementEpoch) { managementBusy = false; gate(); } }
  };
  function announce(message) {
    status.textContent = message;
    onStatus(message);
  }
  function showError(error) {
    errorBox.textContent = typeof error === "string" ? error : error.message || "The image request could not be completed";
    errorBox.hidden = false;
    const key = error?.field?.split(".")[1];
    const input = { name, tags, depthPreset: depth, depthPivot: pivot, collisionGrid: collisions }[key];
    if (input) {
      input.setAttribute("aria-invalid", "true");
      input.setAttribute("aria-errormessage", errorBox.id);
      input.focus();
    }
  }
  function clearError() {
    errorBox.hidden = true;
    errorBox.textContent = "";
    for (const input of [name, tags, depth, pivot, collisions]) {
      input.removeAttribute("aria-invalid");
      input.removeAttribute("aria-errormessage");
    }
  }
  function releasePreview() {
    preview?.dispose?.();
    preview = null;
    previewImage.removeAttribute("src");
    previewBox.hidden = true;
  }
  function releaseThumbs() {
    for (const c of thumbControllers) c.abort();
    thumbControllers.clear();
    for (const url of thumbURLs) URL.revokeObjectURL(url);
    thumbURLs.clear();
  }
  function isCurrent(captured, capability) {
    const fresh = context(getContext);
    return !disposed && captured === scope && scopeOf(fresh) === scope && (!capability || fresh.capabilities[capability] === true);
  }
  function sync() {
    const fresh = context(getContext);
    if (scopeOf(fresh) !== scope) {
      switchContext(fresh);
      return false;
    }
    ctx = fresh;
    gate();
    return true;
  }
  function gate() {
    const caps = ctx.capabilities, locked = submitting || !!pending;
    add.disabled = !caps.canManage;
    search.disabled = !caps.canRead;
    reload.disabled = !caps.canRead;
    chooser.disabled = !caps.canManage || locked;
    fileInput.disabled = chooser.disabled;
    fields.disabled = !caps.canManage || locked;
    upload.disabled = !caps.canManage || !file || !preview || locked;
    cancel.textContent = pending ? "Back to library" : "Cancel draft";
    permission.textContent = !caps.canRead ? "You cannot read this room\u2019s image library." : !caps.canPlace ? "You can view these image objects. Placement is not available for your current role." : !caps.canManage ? "You can place approved room images. Only full room editors can upload and manage the library." : "Room image objects can be reused by people with placement permission.";
    checkUpload.disabled = submitting || !caps.canManage;
    retry.disabled = submitting || !caps.canManage;
    statusLabel.hidden = !caps.canManage;
    libraryStatus.disabled = !caps.canRead || managementBusy;
    managementFields.disabled = !caps.canManage || managementBusy;
    commitManagement.disabled = !caps.canManage || managementBusy || managementConflict;
    cancelManagement.disabled = managementBusy; latest.disabled = managementBusy || !caps.canManage;
    close.disabled = managementBusy;
    for (const b of cards.querySelectorAll("button")) b.disabled = !caps.canRead || managementBusy || (b.dataset.management ? !caps.canManage : !caps.canPlace);
    collisions.disabled = fields.disabled || floating.checked || !preview || preview.width % 32 !== 0 || preview.height % 32 !== 0;
  }
  function draftValues() {
    return { name: name.value, tags: tags.value, depthPreset: depth.value, representation: depth.value === "floor" ? "floor" : "upright", depthPivot: depth.value === "floor" ? 0.5 : depth.value === "standing" ? 1 : pivot.value.trim() ? Number(pivot.value) : NaN, floating: floating.checked, collisionGrid: collisions.checked && !floating.checked ? grid : null };
  }
  function resetDraft() {
    decodeController?.abort();
    decodeEpoch++;
    releasePreview();
    file = null;
    grid = null;
    pending = null;
    submitting = false;
    name.value = "";
    tags.value = "";
    depth.value = "standing";
    pivot.value = "1";
    floating.checked = true;
    collisions.checked = false;
    fileInput.value = "";
    pivot.parentElement.hidden = true;
    gridWrap.hidden = true;
    gridTable.replaceChildren();
    clearError();
    recovery.hidden = true;
    retry.hidden = true;
    gate();
  }
  function showDraft() {
    if (!sync() || !ctx.capabilities.canManage) return;
    draftVisible = true;
    form.hidden = false;
    libraryView.hidden = true;
    gate();
    formTitle.focus();
    if (pending) {
      recovery.hidden = false;
      showError("This upload may have completed. Check its status before trying again.");
    }
  }
  function hideDraft() {
    draftVisible = false;
    form.hidden = true;
    libraryView.hidden = false;
    if (open) add.focus();
  }
  function cancelDraft() {
    if (!sync()) return;
    if (submitting && !pending) {
      resetDraft();
      hideDraft();
      announce("Draft cancelled before transmission. Nothing was uploaded.");
      return;
    }
    if (submitting || pending) {
      if (pending) {
        pending.state = "uncertain";
        pendingByOwner.set(ownerOf(ctx), pending);
      }
      uploadController?.abort();
      submitting = false;
      releasePreview();
      hideDraft();
      announce("Upload status may be unknown. Reopen Add PNG to check it; leaving does not undo a server commit.");
      gate();
      return;
    }
    resetDraft();
    hideDraft();
    announce("Draft cancelled. Nothing was uploaded.");
  }
  function renderGrid() {
    gridWrap.hidden = !collisions.checked || floating.checked;
    if (gridWrap.hidden) return;
    if (!preview || preview.width % 32 || preview.height % 32) {
      collisions.checked = false;
      gridWrap.hidden = true;
      showError("Collision cells require PNG dimensions that are multiples of 32 pixels.");
      return;
    }
    const rows = preview.height / 32, cols = preview.width / 32;
    if (!grid || grid.length !== rows || grid[0].length !== cols) grid = Array.from({ length: rows }, () => Array(cols).fill(0));
    gridTable.style.gridTemplateColumns = `repeat(${cols}, var(--image-cell-size, 44px))`;
    gridTable.replaceChildren();
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
      const b = button("", null, "uil-cell");
      b.textContent = grid[r][c] ? "Block" : "Clear";
      b.setAttribute("aria-label", `Collision row ${r + 1}, column ${c + 1}`);
      b.setAttribute("aria-pressed", String(!!grid[r][c]));
      b.tabIndex = r === 0 && c === 0 ? 0 : -1;
      b.onclick = () => {
        if (!sync() || !ctx.capabilities.canManage || pending) return;
        grid[r][c] = 1 - grid[r][c];
        b.setAttribute("aria-pressed", String(!!grid[r][c]));
        b.textContent = grid[r][c] ? "Block" : "Clear";
      };
      b.onkeydown = (e) => {
        const dir = { ArrowLeft: [0, -1], ArrowRight: [0, 1], ArrowUp: [-1, 0], ArrowDown: [1, 0] }[e.key];
        if (!dir) return;
        e.preventDefault();
        const nr = Math.max(0, Math.min(rows - 1, r + dir[0])), nc = Math.max(0, Math.min(cols - 1, c + dir[1]));
        const next = gridTable.children[nr * cols + nc];
        b.tabIndex = -1;
        next.tabIndex = 0;
        next.focus();
      };
      gridTable.append(b);
    }
  }
  async function selectFile(selected) {
    if (!sync() || !ctx.capabilities.canManage || pending || submitting) return;
    clearError();
    const captured = scope, serial = ++decodeEpoch;
    decodeController?.abort();
    decodeController = new AbortController();
    announce("Reading local PNG preview\u2026");
    const old = preview;
    try {
      const next = await decodePreview(selected, { signal: decodeController.signal });
      if (serial !== decodeEpoch || !isCurrent(captured, "canManage")) {
        next.dispose?.();
        return;
      }
      if (!next.previewUrl || typeof next.dispose !== "function") throw new Error("The local preview adapter returned an invalid preview");
      old?.dispose?.();
      preview = next;
      file = selected;
      grid = null;
      collisions.checked = false;
      previewImage.src = next.previewUrl;
      previewBox.hidden = false;
      name.value = name.value || selected.name.replace(/\.png$/i, "");
      dimensions.textContent = `${next.width} \xD7 ${next.height} px \xB7 ${next.width / 32} \xD7 ${next.height / 32} m at 32 px per metre`;
      announce("Local preview ready. Configure it before uploading.");
      renderGrid();
      gate();
    } catch (error) {
      if (serial !== decodeEpoch || !isCurrent(captured)) return;
      if (error.name !== "AbortError") showError(error);
      announce(file ? "Previous draft preserved. Nothing was uploaded." : "Nothing was uploaded.");
      gate();
    }
  }
  function validEntry(value, allowArchived = false) {
    const result = validateResolvedImageAsset(value);
    if (!(result.status === "active" || allowArchived && result.status === "archived") || result.definition.roomId !== ctx.roomId) throw new Error("Image is not available in this room");
    return result;
  }
  async function thumbnail(entry, img, caption, token) {
    const captured = scope, controller = new AbortController();
    thumbControllers.add(controller);
    try {
      const value = await service.readImage({ roomId: ctx.roomId, assetId: entry.definition.assetId, versionId: entry.version.versionId, signal: controller.signal });
      if (!isCurrent(captured, "canRead") || token !== listEpoch || !img.isConnected) return;
      const blob = value instanceof Blob ? value : new Blob([value.bytes], { type: value.mediaType });
      if (blob.type !== "image/png" || !blob.size || blob.size > IMAGE_ASSET_LIMITS.maxBytes) throw new Error("Unavailable");
      const url = URL.createObjectURL(blob);
      thumbURLs.add(url);
      img.onerror = () => {
        if (isCurrent(captured) && img.isConnected) {
          img.hidden = true;
          caption.textContent = "Preview unavailable";
        }
      };
      img.onload = () => {
        if (isCurrent(captured, "canRead") && token === listEpoch && img.isConnected) {
          img.hidden = false;
          caption.textContent = "";
        }
      };
      img.src = url;
    } catch (error) {
      if (isCurrent(captured) && img.isConnected && !controller.signal.aborted) caption.textContent = "Preview unavailable";
    } finally {
      thumbControllers.delete(controller);
    }
  }
  function renderCards() {
    releaseThumbs();
    cards.replaceChildren();
    if (!ctx.capabilities.canRead) {
      listStatus.textContent = "Library access is unavailable.";
      return;
    }
    if (!listReady) return;
    const matches = searchImageLibrary(entries, { query: search.value, category: "custom", status: libraryStatus.value });
    listStatus.textContent = matches.length ? `${matches.length} image object${matches.length === 1 ? "" : "s"}` : search.value ? "No matching image objects. Try another name, description or tag." : "No image objects in this view.";
    for (const entry of matches) {
      const li = el("li", "uil-card");
      li.dataset.assetId = entry.definition.assetId;
      const figure = el("div", "uil-thumb"), img = el("img"), caption = el("span", "uil-note", "Loading preview\u2026");
      img.alt = "";
      img.hidden = true;
      figure.append(img, caption);
      const text = el("div", "uil-card-copy");
      const metadata = imageLibraryMetadata(entry);
      text.append(el("strong", null, metadata.name), el("span", "uil-note", metadata.description), el("span", "uil-note", metadata.tags.join(", ") || "No tags"), el("span", "uil-note", entry.version.representation === "floor" ? "Floor decal" : "Upright panel"));
      const use = button(`Place ${metadata.name}`, "Plus");
      use.setAttribute("aria-label", `Place ${metadata.name} (${entry.definition.assetId})`);
      use.onclick = () => {
        if (!sync() || !isCurrent(scope, "canRead") || entry.status !== "active" || !ctx.capabilities.canPlace || !entries.some((item) => item.definition.assetId === entry.definition.assetId && item.version.versionId === entry.version.versionId)) return;
        onChoose({ assetId: entry.definition.assetId, versionId: entry.version.versionId });
        announce(`Selected ${metadata.name} for placement. Click in the world to place it.`);
      };
      li.append(figure, text);
      if (entry.status === "active") li.append(use);
      if (ctx.capabilities.canManage) {
        const edit = button(`Edit ${metadata.name}`, null); edit.dataset.management = "true"; edit.onclick = () => showManagement(entry);
        const change = button(`${entry.status === "active" ? "Archive" : "Restore"} ${metadata.name}`, null); change.dataset.management = "true";
        change.onclick = () => entry.status === "active" ? showManagement(entry, "archive") : mutateAsset(entry, {status: "active"}, "restore");
        li.append(edit, change);
      }
      cards.append(li);
      thumbnail(entry, img, caption, listEpoch);
    }
    gate();
  }
  async function refresh() {
    if (!sync()) return;
    const captured = scope, token = ++listEpoch;
    listController?.abort();
    listController = new AbortController();
    releaseThumbs();
    entries = [];
    listReady = false;
    cards.replaceChildren();
    if (!ctx.capabilities.canRead) {
      listStatus.textContent = "Library access is unavailable.";
      return;
    }
    listStatus.textContent = "Loading Custom image objects\u2026";
    cards.setAttribute("aria-busy", "true");
    try {
      const result = await service.list({ roomId: ctx.roomId, query: "", status: libraryStatus.value, signal: listController.signal });
      if (!isCurrent(captured, "canRead") || token !== listEpoch) return;
      if (!Array.isArray(result?.entries)) throw new Error("Invalid library response");
      entries = result.entries.map(item => validEntry(item, libraryStatus.value === "archived"));
      listReady = true;
      renderCards();
    } catch (error) {
      if (!isCurrent(captured) || token !== listEpoch) return;
      if (error.name !== "AbortError") listStatus.textContent = `Could not load the library. ${error.message || "Try Refresh."}`;
    } finally {
      if (isCurrent(captured) && token === listEpoch) cards.removeAttribute("aria-busy");
    }
  }
  function complete(entry, operation) {
    const result = validEntry(entry, true);
    pendingByOwner.delete(operation.owner);
    if (pending !== operation) return;
    pending = null;
    resetDraft();
    hideDraft();
    if (result.status === "archived") libraryStatus.value = "archived";
    announce(result.status === "archived" ? `Upload confirmed: ${imageLibraryMetadata(result).name} is archived. Restore it before placing.` : `Uploaded ${imageLibraryMetadata(result).name}. It is ready in Custom; no world object has been placed.`);
    refresh();
  }
  async function reconcile() {
    if (!sync() || !pending || submitting || !ctx.capabilities.canManage) return;
    const operation = pending, captured = scope;
    submitting = true;
    retry.hidden = true;
    gate();
    announce("Checking whether the upload committed\u2026");
    try {
      const result = await service.reconcileCreate({ roomId: ctx.roomId, operationId: operation.operationId, signal: void 0 });
      if (!isCurrent(captured, "canManage") || pending !== operation) return;
      if (result?.status === "committed") {
        complete(result.entry, operation);
        return;
      }
      if (result?.status !== "not-found") throw new Error("Upload status is still unknown");
      operation.state = "retryable";
      retry.hidden = false;
      showError("No committed receipt was found yet; the original request may still finish. Retry sends the same unchanged upload and operation ID.");
      await refresh();
    } catch (error) {
      if (isCurrent(captured) && pending === operation) showError("Could not confirm upload status. Your unchanged submission is preserved. Check again before retrying.");
    } finally {
      if (isCurrent(captured) && pending === operation) {
        submitting = false;
        gate();
      }
    }
  }
  async function send(operation) {
    const captured = scope;
    submitting = true;
    pending = operation;
    pendingByOwner.set(operation.owner, operation);
    uploadController = new AbortController();
    gate();
    clearError();
    recovery.hidden = true;
    announce("Uploading PNG\u2026");
    try {
      const result = await service.create({ roomId: ctx.roomId, draft: operation.draft, bytes: operation.bytes, mediaType: "image/png", operationId: operation.operationId, signal: uploadController.signal });
      if (!isCurrent(captured, "canManage") || pending !== operation) {
        operation.state = "uncertain";
        return;
      }
      complete(result, operation);
    } catch (error) {
      operation.state = "uncertain";
      if (!isCurrent(captured) || pending !== operation) return;
      if (error.definitive === true) {
        pendingByOwner.delete(operation.owner);
        pending = null;
        showError(error);
        announce("Upload rejected. Your draft is preserved.");
      } else {
        showError("The upload response was interrupted. It may have completed. Check its status before retrying.");
        recovery.hidden = false;
        retry.hidden = true;
        announce("Upload status is unknown; your unchanged submission is preserved.");
      }
    } finally {
      if (isCurrent(captured)) {
        submitting = false;
        gate();
      }
    }
  }
  async function submit() {
    if (!sync() || !ctx.capabilities.canManage || submitting || pending) return;
    clearError();
    if (!file || !preview) {
      showError("Choose a PNG image first.");
      return;
    }
    const raw = draftValues();
    try {
      normalizeImageAssetDraft(raw, { width: preview.width, height: preview.height, byteLength: file.size, mediaType: file.type });
    } catch (error) {
      showError(error);
      return;
    }
    const captured = scope, selected = file;
    submitting = true;
    gate();
    try {
      const bytes = new Uint8Array(await selected.arrayBuffer());
      if (!isCurrent(captured, "canManage") || selected !== file) return;
      await send({ owner: ownerOf(ctx), operationId: crypto.randomUUID(), draft: structuredClone(raw), bytes, state: "pending" });
    } catch (error) {
      if (isCurrent(captured)) showError(error);
    } finally {
      if (isCurrent(captured)) {
        submitting = false;
        gate();
      }
    }
  }
  function switchContext(next) {
    managementEpoch++; managementController?.abort(); hideManagement({focus: false}); libraryStatus.value = "active";
    cards.removeAttribute("aria-busy");
    if (pending) {
      pending.state = "uncertain";
      pendingByOwner.set(ownerOf(ctx), pending);
    }
    listController?.abort();
    decodeController?.abort();
    uploadController?.abort();
    listEpoch++;
    decodeEpoch++;
    releaseThumbs();
    resetDraft();
    entries = [];
    listReady = false;
    cards.replaceChildren();
    ctx = next;
    scope = scopeOf(ctx);
    pending = pendingByOwner.get(ownerOf(ctx)) || null;
    search.value = "";
    hideDraft();
    gate();
    announce(pending ? "An earlier upload in this room needs a status check." : "");
    if (open) {
      refresh();
      if (pending && ctx.capabilities.canManage) reconcile();
    }
  }
  function attachRoom() {
    const fresh = context(getContext);
    if (scopeOf(fresh) !== scope) switchContext(fresh);
    else {
      ctx = fresh;
      gate();
      if (!ctx.capabilities.canRead) {
        releaseThumbs();
        entries = [];
        cards.replaceChildren();
        listReady = false;
      }
      if (open) refresh();
    }
  }
  function setOpen(value, trigger) {
    if (disposed) return;
    if (value) {
      returnFocus = trigger || document.activeElement;
      open = true;
      root.hidden = false;
      sync();
      refresh();
      if (editing) managementTitle.focus();
      else if (draftVisible) formTitle.focus();
      else search.focus();
      if (pending && ctx.capabilities.canManage) reconcile();
    } else {
      open = false;
      root.hidden = true;
      releaseThumbs();
      if (returnFocus?.isConnected) returnFocus.focus();
    }
  }
  chooser.onclick = () => {
    if (sync() && ctx.capabilities.canManage && !pending && !submitting) fileInput.click();
  };
  fileInput.onchange = () => {
    if (fileInput.files.length) selectFile(fileInput.files[0]);
    fileInput.value = "";
  };
  drop.ondragover = (e) => {
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = ctx.capabilities.canManage && !pending ? "copy" : "none";
  };
  drop.ondrop = (e) => {
    e.preventDefault();
    if (!sync() || !ctx.capabilities.canManage || pending) return;
    const files = [...e.dataTransfer?.files || []];
    if (files.length !== 1) {
      showError("Drop exactly one PNG image.");
      return;
    }
    selectFile(files[0]);
  };
  add.onclick = showDraft;
  reload.onclick = refresh;
  libraryStatus.onchange = () => { if (sync()) refresh(); };
  close.onclick = () => setOpen(false);
  cancel.onclick = cancelDraft;
  checkUpload.onclick = reconcile;
  retry.onclick = () => {
    if (sync() && pending?.state === "retryable" && !submitting && ctx.capabilities.canManage) send(pending);
  };
  form.onsubmit = (e) => {
    e.preventDefault();
    if (!composing) submit();
  };
  depth.onchange = () => {
    pivot.parentElement.hidden = depth.value !== "custom";
  };
  floating.onchange = () => {
    if (floating.checked) collisions.checked = false;
    renderGrid();
    gate();
  };
  collisions.onchange = renderGrid;
  search.oninput = () => {
    if (!composing && sync()) renderCards();
  };
  const onCompositionStart = () => {
    composing = true;
  };
  const onCompositionEnd = () => {
    composing = false;
    if (document.activeElement === search && sync()) renderCards();
  };
  const onKeyDown = (e) => {
    e.stopPropagation();
    if (e.isComposing || composing) return;
    if (e.key === "Escape") {
      e.preventDefault();
      if (managementBusy) return;
      if (editing) hideManagement();
      else if (draftVisible) cancelDraft();
      else setOpen(false);
    }
  };
  root.addEventListener("compositionstart", onCompositionStart);
  root.addEventListener("compositionend", onCompositionEnd);
  root.addEventListener("keydown", onKeyDown);
  function dispose() {
    if (disposed) return;
    disposed = true;
    managementEpoch++; managementController?.abort();
    root.removeEventListener("compositionstart", onCompositionStart);
    root.removeEventListener("compositionend", onCompositionEnd);
    root.removeEventListener("keydown", onKeyDown);
    listController?.abort();
    decodeController?.abort();
    uploadController?.abort();
    releasePreview();
    releaseThumbs();
    pendingByOwner.clear();
    entries = [];
    file = null;
    root.replaceChildren();
    root.hidden = true;
  }
  gate();
  return Object.freeze({ attachRoom, setOpen, refresh, cancelDraft, dispose });
}
export {
  mountImageLibrary
};
