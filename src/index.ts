import express, { Request, Response, NextFunction } from "express";
import cors from "cors";
import { drive as createDrive, drive_v3 } from "@googleapis/drive";
import { OAuth2Client } from "google-auth-library";

const app = express();
app.use(cors());
app.use(express.json({ limit: "10mb" }));

const clientId = process.env.GOOGLE_CLIENT_ID!;
const clientSecret = process.env.GOOGLE_CLIENT_SECRET!;
const refreshToken = process.env.GOOGLE_REFRESH_TOKEN!;
const API_KEY = process.env.API_KEY || "changeme";
if (!clientId || !clientSecret || !refreshToken) { console.error("Missing Google env vars"); process.exit(1); }
const auth = new OAuth2Client(clientId, clientSecret);
auth.setCredentials({ refresh_token: refreshToken });
const drive: drive_v3.Drive = createDrive({ version: "v3", auth });

function requireApiKey(req: Request, res: Response, next: NextFunction): void {
  const key = req.headers["x-api-key"] || req.headers["authorization"]?.replace("Bearer ", "");
  if (key !== API_KEY) { res.status(401).json({ error: "Invalid API key" }); return; }
  next();
}
app.use("/api", requireApiKey);

function ok(res: Response, data: unknown) { res.json(data); }
function er(res: Response, e: unknown) { res.status(500).json({ error: e instanceof Error ? e.message : String(e) }); }

// ===== FILES =====
app.get("/api/files", async (req: Request, res: Response) => {
  try {
    const { query, folderId, mimeType, pageSize, pageToken, orderBy, trashed } = req.query;
    const parts: string[] = [];
    if (folderId) parts.push(`'${folderId}' in parents`);
    if (mimeType) parts.push(`mimeType='${mimeType}'`);
    parts.push(`trashed=${trashed === "true"}`);
    if (query) parts.push(query as string);
    const r = await drive.files.list({ q: parts.join(" and "), pageSize: Number(pageSize) || 50, pageToken: pageToken as string, orderBy: orderBy as string, supportsAllDrives: true, includeItemsFromAllDrives: true, fields: "nextPageToken,files(id,name,mimeType,size,modifiedTime,createdTime,parents,webViewLink,shared,starred,trashed,owners)" });
    ok(res, { files: r.data.files, nextPageToken: r.data.nextPageToken });
  } catch (e) { er(res, e); }
});

app.get("/api/files/search", async (req: Request, res: Response) => {
  try {
    const r = await drive.files.list({ q: req.query.query as string, pageSize: Number(req.query.pageSize) || 20, pageToken: req.query.pageToken as string, supportsAllDrives: true, includeItemsFromAllDrives: true, fields: "nextPageToken,files(id,name,mimeType,size,modifiedTime,webViewLink,parents)" });
    ok(res, { files: r.data.files, nextPageToken: r.data.nextPageToken });
  } catch (e) { er(res, e); }
});

app.get("/api/files/duplicates", async (req: Request, res: Response) => {
  try {
    const name = req.query.name as string;
    const folderId = req.query.folderId as string;
    const parts = [`name='${name.replace(/'/g, "\\'")}'`, "trashed=false"];
    if (folderId) parts.push(`'${folderId}' in parents`);
    const r = await drive.files.list({ q: parts.join(" and "), pageSize: 100, supportsAllDrives: true, includeItemsFromAllDrives: true, fields: "files(id,name,mimeType,size,modifiedTime,parents,webViewLink,owners,createdTime)" });
    ok(res, { name, duplicates: r.data.files, count: (r.data.files || []).length });
  } catch (e) { er(res, e); }
});

app.post("/api/files/generate-ids", async (req: Request, res: Response) => {
  try {
    const r = await drive.files.generateIds({ count: Number(req.body.count) || 10 });
    ok(res, r.data);
  } catch (e) { er(res, e); }
});

app.post("/api/files/empty-trash", async (_req: Request, res: Response) => {
  try { await drive.files.emptyTrash({}); ok(res, { success: true }); } catch (e) { er(res, e); }
});

app.get("/api/files/:fileId", async (req: Request, res: Response) => {
  try { ok(res, (await drive.files.get({ fileId: req.params.fileId, fields: "*", supportsAllDrives: true })).data); } catch (e) { er(res, e); }
});

app.get("/api/files/:fileId/content", async (req: Request, res: Response) => {
  try {
    const r = await drive.files.get({ fileId: req.params.fileId, alt: "media", supportsAllDrives: true }, { responseType: "arraybuffer" });
    const buf = Buffer.from(r.data as ArrayBuffer);
    const enc = req.query.encoding === "base64" ? "base64" : "utf8";
    ok(res, { content: buf.toString(enc), encoding: enc, size: buf.length });
  } catch (e) { er(res, e); }
});

app.get("/api/files/:fileId/export", async (req: Request, res: Response) => {
  try {
    const mt = req.query.mimeType as string;
    const r = await drive.files.export({ fileId: req.params.fileId, mimeType: mt }, { responseType: "arraybuffer" });
    const buf = Buffer.from(r.data as ArrayBuffer);
    const isText = mt?.startsWith("text/");
    ok(res, { content: buf.toString(isText ? "utf8" : "base64"), mimeType: mt, encoding: isText ? "utf8" : "base64", size: buf.length });
  } catch (e) { er(res, e); }
});

app.get("/api/files/:fileId/path", async (req: Request, res: Response) => {
  try {
    const path: string[] = [];
    let cid = req.params.fileId;
    for (let i = 0; i < 20; i++) {
      const r = await drive.files.get({ fileId: cid, fields: "id,name,parents", supportsAllDrives: true });
      path.unshift(r.data.name ?? cid);
      if (!r.data.parents?.length) break;
      cid = r.data.parents[0];
    }
    ok(res, { fileId: req.params.fileId, path: path.join("/"), segments: path });
  } catch (e) { er(res, e); }
});

app.get("/api/files/:fileId/sharing-summary", async (req: Request, res: Response) => {
  try {
    const [f, p] = await Promise.all([
      drive.files.get({ fileId: req.params.fileId, fields: "id,name,mimeType,shared,webViewLink", supportsAllDrives: true }),
      drive.permissions.list({ fileId: req.params.fileId, supportsAllDrives: true, fields: "permissions(id,type,role,emailAddress,domain,displayName)" })
    ]);
    ok(res, { file: f.data, permissions: p.data.permissions, totalPermissions: (p.data.permissions || []).length });
  } catch (e) { er(res, e); }
});

app.post("/api/files", async (req: Request, res: Response) => {
  try {
    const { name, mimeType, content, contentEncoding, parentId, description } = req.body;
    const metadata: drive_v3.Schema$File = { name, mimeType: mimeType || "text/plain", description };
    if (parentId) metadata.parents = [parentId];
    let media: { mimeType: string; body: Buffer | string } | undefined;
    if (content) { media = { mimeType: mimeType || "text/plain", body: contentEncoding === "base64" ? Buffer.from(content, "base64") : content }; }
    ok(res, (await drive.files.create({ requestBody: metadata, media, supportsAllDrives: true, fields: "id,name,mimeType,webViewLink,parents,createdTime" })).data);
  } catch (e) { er(res, e); }
});

app.patch("/api/files/:fileId", async (req: Request, res: Response) => {
  try {
    const rb: drive_v3.Schema$File = {};
    if (req.body.name !== undefined) rb.name = req.body.name;
    if (req.body.description !== undefined) rb.description = req.body.description;
    if (req.body.starred !== undefined) rb.starred = req.body.starred;
    ok(res, (await drive.files.update({ fileId: req.params.fileId, requestBody: rb, supportsAllDrives: true, fields: "id,name,description,starred,modifiedTime" })).data);
  } catch (e) { er(res, e); }
});

app.put("/api/files/:fileId/content", async (req: Request, res: Response) => {
  try {
    const body = req.body.contentEncoding === "base64" ? Buffer.from(req.body.content, "base64") : req.body.content;
    ok(res, (await drive.files.update({ fileId: req.params.fileId, requestBody: {}, media: { mimeType: req.body.mimeType || "text/plain", body }, supportsAllDrives: true, fields: "id,name,size,modifiedTime" })).data);
  } catch (e) { er(res, e); }
});

app.post("/api/files/:fileId/copy", async (req: Request, res: Response) => {
  try {
    const rb: drive_v3.Schema$File = {};
    if (req.body.name) rb.name = req.body.name;
    if (req.body.parentId) rb.parents = [req.body.parentId];
    ok(res, (await drive.files.copy({ fileId: req.params.fileId, requestBody: rb, supportsAllDrives: true, fields: "id,name,mimeType,webViewLink,parents" })).data);
  } catch (e) { er(res, e); }
});

app.post("/api/files/:fileId/move", async (req: Request, res: Response) => {
  try {
    const cur = await drive.files.get({ fileId: req.params.fileId, fields: "parents", supportsAllDrives: true });
    ok(res, (await drive.files.update({ fileId: req.params.fileId, addParents: req.body.newParentId, removeParents: (cur.data.parents || []).join(","), requestBody: {}, supportsAllDrives: true, fields: "id,name,parents" })).data);
  } catch (e) { er(res, e); }
});

app.post("/api/files/:fileId/trash", async (req: Request, res: Response) => {
  try { ok(res, (await drive.files.update({ fileId: req.params.fileId, requestBody: { trashed: true }, supportsAllDrives: true, fields: "id,name,trashed" })).data); } catch (e) { er(res, e); }
});

app.post("/api/files/:fileId/restore", async (req: Request, res: Response) => {
  try { ok(res, (await drive.files.update({ fileId: req.params.fileId, requestBody: { trashed: false }, supportsAllDrives: true, fields: "id,name,trashed" })).data); } catch (e) { er(res, e); }
});

app.delete("/api/files/:fileId", async (req: Request, res: Response) => {
  try { await drive.files.delete({ fileId: req.params.fileId, supportsAllDrives: true }); ok(res, { deleted: true, fileId: req.params.fileId }); } catch (e) { er(res, e); }
});

// ===== FOLDERS =====
app.post("/api/folders", async (req: Request, res: Response) => {
  try {
    const md: drive_v3.Schema$File = { name: req.body.name, mimeType: "application/vnd.google-apps.folder", description: req.body.description };
    if (req.body.parentId) md.parents = [req.body.parentId];
    ok(res, (await drive.files.create({ requestBody: md, supportsAllDrives: true, fields: "id,name,mimeType,parents,webViewLink,createdTime" })).data);
  } catch (e) { er(res, e); }
});

app.get("/api/folders/:folderId/contents", async (req: Request, res: Response) => {
  try {
    const r = await drive.files.list({ q: `'${req.params.folderId}' in parents and trashed=false`, pageSize: Number(req.query.pageSize) || 100, pageToken: req.query.pageToken as string, supportsAllDrives: true, includeItemsFromAllDrives: true, orderBy: "folder,name", fields: "nextPageToken,files(id,name,mimeType,size,modifiedTime,webViewLink,shared)" });
    ok(res, { files: r.data.files, nextPageToken: r.data.nextPageToken });
  } catch (e) { er(res, e); }
});

app.get("/api/folders/:folderId/tree", async (req: Request, res: Response) => {
  try {
    const maxDepth = Math.min(Number(req.query.maxDepth) || 2, 5);
    const includeFiles = req.query.includeFiles !== "false";
    async function build(pid: string, d: number): Promise<unknown[]> {
      if (d > maxDepth) return [];
      const q = includeFiles ? `'${pid}' in parents and trashed=false` : `'${pid}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`;
      const r = await drive.files.list({ q, pageSize: 200, orderBy: "folder,name", supportsAllDrives: true, includeItemsFromAllDrives: true, fields: "files(id,name,mimeType,size)" });
      const items = r.data.files || [];
      const out = [];
      for (const it of items) {
        const isF = it.mimeType === "application/vnd.google-apps.folder";
        const n: Record<string, unknown> = { id: it.id, name: it.name, mimeType: it.mimeType };
        if (!isF && it.size) n.size = it.size;
        if (isF && d < maxDepth) n.children = await build(it.id!, d + 1);
        out.push(n);
      }
      return out;
    }
    ok(res, { folderId: req.params.folderId, maxDepth, tree: await build(req.params.folderId, 1) });
  } catch (e) { er(res, e); }
});

// ===== PERMISSIONS =====
app.get("/api/files/:fileId/permissions", async (req: Request, res: Response) => {
  try { ok(res, { permissions: (await drive.permissions.list({ fileId: req.params.fileId, supportsAllDrives: true, fields: "permissions(id,type,role,emailAddress,domain,displayName,expirationTime)" })).data.permissions }); } catch (e) { er(res, e); }
});

app.get("/api/files/:fileId/permissions/:permissionId", async (req: Request, res: Response) => {
  try { ok(res, (await drive.permissions.get({ fileId: req.params.fileId, permissionId: req.params.permissionId, supportsAllDrives: true, fields: "id,type,role,emailAddress,domain,displayName,expirationTime" })).data); } catch (e) { er(res, e); }
});

app.post("/api/files/:fileId/permissions", async (req: Request, res: Response) => {
  try {
    const rb: drive_v3.Schema$Permission = { role: req.body.role, type: req.body.type };
    if (req.body.emailAddress) rb.emailAddress = req.body.emailAddress;
    if (req.body.domain) rb.domain = req.body.domain;
    if (req.body.expirationTime) rb.expirationTime = req.body.expirationTime;
    ok(res, (await drive.permissions.create({ fileId: req.params.fileId, requestBody: rb, sendNotificationEmail: req.body.sendNotificationEmail !== false, transferOwnership: req.body.transferOwnership || false, supportsAllDrives: true, fields: "id,type,role,emailAddress,displayName" })).data);
  } catch (e) { er(res, e); }
});

app.patch("/api/files/:fileId/permissions/:permissionId", async (req: Request, res: Response) => {
  try {
    const rb: drive_v3.Schema$Permission = { role: req.body.role };
    if (req.body.expirationTime) rb.expirationTime = req.body.expirationTime;
    ok(res, (await drive.permissions.update({ fileId: req.params.fileId, permissionId: req.params.permissionId, requestBody: rb, transferOwnership: req.body.transferOwnership || false, supportsAllDrives: true, fields: "id,type,role,emailAddress,displayName,expirationTime" })).data);
  } catch (e) { er(res, e); }
});

app.delete("/api/files/:fileId/permissions/:permissionId", async (req: Request, res: Response) => {
  try { await drive.permissions.delete({ fileId: req.params.fileId, permissionId: req.params.permissionId, supportsAllDrives: true }); ok(res, { deleted: true }); } catch (e) { er(res, e); }
});

// ===== COMMENTS =====
app.get("/api/files/:fileId/comments", async (req: Request, res: Response) => {
  try { ok(res, { comments: (await drive.comments.list({ fileId: req.params.fileId, includeDeleted: req.query.includeDeleted === "true", pageSize: Number(req.query.pageSize) || 50, pageToken: req.query.pageToken as string, fields: "nextPageToken,comments(id,content,author,createdTime,modifiedTime,resolved,deleted,replies)" })).data.comments }); } catch (e) { er(res, e); }
});

app.get("/api/files/:fileId/comments/:commentId", async (req: Request, res: Response) => {
  try { ok(res, (await drive.comments.get({ fileId: req.params.fileId, commentId: req.params.commentId, fields: "id,content,author,createdTime,modifiedTime,resolved,deleted,replies" })).data); } catch (e) { er(res, e); }
});

app.post("/api/files/:fileId/comments", async (req: Request, res: Response) => {
  try { ok(res, (await drive.comments.create({ fileId: req.params.fileId, requestBody: { content: req.body.content }, fields: "id,content,author,createdTime" })).data); } catch (e) { er(res, e); }
});

app.patch("/api/files/:fileId/comments/:commentId", async (req: Request, res: Response) => {
  try { ok(res, (await drive.comments.update({ fileId: req.params.fileId, commentId: req.params.commentId, requestBody: { content: req.body.content }, fields: "id,content,author,createdTime,modifiedTime" })).data); } catch (e) { er(res, e); }
});

app.delete("/api/files/:fileId/comments/:commentId", async (req: Request, res: Response) => {
  try { await drive.comments.delete({ fileId: req.params.fileId, commentId: req.params.commentId }); ok(res, { deleted: true }); } catch (e) { er(res, e); }
});

// ===== REPLIES =====
app.get("/api/files/:fileId/comments/:commentId/replies", async (req: Request, res: Response) => {
  try { ok(res, { replies: (await drive.replies.list({ fileId: req.params.fileId, commentId: req.params.commentId, includeDeleted: req.query.includeDeleted === "true", pageSize: Number(req.query.pageSize) || 50, fields: "nextPageToken,replies(id,content,author,createdTime,modifiedTime,deleted)" })).data.replies }); } catch (e) { er(res, e); }
});

app.post("/api/files/:fileId/comments/:commentId/replies", async (req: Request, res: Response) => {
  try { ok(res, (await drive.replies.create({ fileId: req.params.fileId, commentId: req.params.commentId, requestBody: { content: req.body.content }, fields: "id,content,author,createdTime" })).data); } catch (e) { er(res, e); }
});

app.delete("/api/files/:fileId/comments/:commentId/replies/:replyId", async (req: Request, res: Response) => {
  try { await drive.replies.delete({ fileId: req.params.fileId, commentId: req.params.commentId, replyId: req.params.replyId }); ok(res, { deleted: true }); } catch (e) { er(res, e); }
});

// ===== REVISIONS =====
app.get("/api/files/:fileId/revisions", async (req: Request, res: Response) => {
  try { ok(res, { revisions: (await drive.revisions.list({ fileId: req.params.fileId, pageSize: Number(req.query.pageSize) || 100, pageToken: req.query.pageToken as string, fields: "nextPageToken,revisions(id,mimeType,modifiedTime,keepForever,published,lastModifyingUser,size)" })).data.revisions }); } catch (e) { er(res, e); }
});

app.get("/api/files/:fileId/revisions/:revisionId", async (req: Request, res: Response) => {
  try { ok(res, (await drive.revisions.get({ fileId: req.params.fileId, revisionId: req.params.revisionId, fields: "id,mimeType,modifiedTime,keepForever,published,lastModifyingUser,size" })).data); } catch (e) { er(res, e); }
});

app.patch("/api/files/:fileId/revisions/:revisionId", async (req: Request, res: Response) => {
  try {
    const rb: drive_v3.Schema$Revision = {};
    if (req.body.keepForever !== undefined) rb.keepForever = req.body.keepForever;
    if (req.body.published !== undefined) rb.published = req.body.published;
    ok(res, (await drive.revisions.update({ fileId: req.params.fileId, revisionId: req.params.revisionId, requestBody: rb, fields: "id,mimeType,modifiedTime,keepForever,published,lastModifyingUser,size" })).data);
  } catch (e) { er(res, e); }
});

app.delete("/api/files/:fileId/revisions/:revisionId", async (req: Request, res: Response) => {
  try { await drive.revisions.delete({ fileId: req.params.fileId, revisionId: req.params.revisionId }); ok(res, { deleted: true }); } catch (e) { er(res, e); }
});

// ===== SHARED DRIVES =====
app.get("/api/drives", async (_req: Request, res: Response) => {
  try { ok(res, { drives: (await drive.drives.list({ pageSize: 100, fields: "drives(id,name,createdTime,capabilities,restrictions)" })).data.drives }); } catch (e) { er(res, e); }
});

app.get("/api/drives/:driveId", async (req: Request, res: Response) => {
  try { ok(res, (await drive.drives.get({ driveId: req.params.driveId, fields: "id,name,createdTime,capabilities,restrictions" })).data); } catch (e) { er(res, e); }
});

app.post("/api/drives", async (req: Request, res: Response) => {
  try { ok(res, (await drive.drives.create({ requestId: req.body.requestId || `req-${Date.now()}`, requestBody: { name: req.body.name }, fields: "id,name,createdTime" })).data); } catch (e) { er(res, e); }
});

app.patch("/api/drives/:driveId", async (req: Request, res: Response) => {
  try { ok(res, (await drive.drives.update({ driveId: req.params.driveId, requestBody: { name: req.body.name }, fields: "id,name,createdTime" })).data); } catch (e) { er(res, e); }
});

app.delete("/api/drives/:driveId", async (req: Request, res: Response) => {
  try { await drive.drives.delete({ driveId: req.params.driveId }); ok(res, { deleted: true }); } catch (e) { er(res, e); }
});

app.post("/api/drives/:driveId/hide", async (req: Request, res: Response) => {
  try { ok(res, (await drive.drives.hide({ driveId: req.params.driveId })).data); } catch (e) { er(res, e); }
});

app.post("/api/drives/:driveId/unhide", async (req: Request, res: Response) => {
  try { ok(res, (await drive.drives.unhide({ driveId: req.params.driveId })).data); } catch (e) { er(res, e); }
});

// ===== CHANGES =====
app.get("/api/changes/start-page-token", async (req: Request, res: Response) => {
  try {
    const p: drive_v3.Params$Resource$Changes$Getstartpagetoken = { supportsAllDrives: true };
    if (req.query.driveId) p.driveId = req.query.driveId as string;
    ok(res, (await drive.changes.getStartPageToken(p)).data);
  } catch (e) { er(res, e); }
});

app.get("/api/changes", async (req: Request, res: Response) => {
  try {
    const r = await drive.changes.list({
      pageToken: req.query.pageToken as string, pageSize: Number(req.query.pageSize) || 100,
      includeRemoved: req.query.includeRemoved !== "false", supportsAllDrives: true, includeItemsFromAllDrives: true,
      fields: "nextPageToken,newStartPageToken,changes(changeType,time,removed,fileId,file(id,name,mimeType,modifiedTime,trashed,parents,webViewLink,size),driveId,drive(id,name))"
    });
    ok(res, { changes: r.data.changes, nextPageToken: r.data.nextPageToken, newStartPageToken: r.data.newStartPageToken });
  } catch (e) { er(res, e); }
});

app.post("/api/changes/watch", async (req: Request, res: Response) => {
  try {
    ok(res, (await drive.changes.watch({
      pageToken: req.body.pageToken, supportsAllDrives: true, includeItemsFromAllDrives: true,
      requestBody: { id: req.body.channelId, type: "web_hook", address: req.body.webhookUrl, ...(req.body.expirationMs ? { expiration: req.body.expirationMs } : {}) }
    })).data);
  } catch (e) { er(res, e); }
});

app.post("/api/files/:fileId/watch", async (req: Request, res: Response) => {
  try {
    ok(res, (await drive.files.watch({
      fileId: req.params.fileId, supportsAllDrives: true,
      requestBody: { id: req.body.channelId, type: "web_hook", address: req.body.webhookUrl, ...(req.body.expirationMs ? { expiration: req.body.expirationMs } : {}) }
    })).data);
  } catch (e) { er(res, e); }
});

app.post("/api/channels/stop", async (req: Request, res: Response) => {
  try { await drive.channels.stop({ requestBody: { id: req.body.channelId, resourceId: req.body.resourceId } }); ok(res, { stopped: true }); } catch (e) { er(res, e); }
});

// ===== ABOUT =====
app.get("/api/about", async (_req: Request, res: Response) => {
  try {
    const r = await drive.about.get({ fields: "user,storageQuota,appInstalled,importFormats,exportFormats,maxUploadSize" });
    const q = r.data.storageQuota;
    ok(res, { user: r.data.user, storageQuota: { limit: q?.limit ? `${(Number(q.limit) / 1073741824).toFixed(2)} GB` : "unlimited", usage: q?.usage ? `${(Number(q.usage) / 1073741824).toFixed(2)} GB` : "0", usageInDrive: q?.usageInDrive ? `${(Number(q.usageInDrive) / 1073741824).toFixed(2)} GB` : "0", usageInDriveTrash: q?.usageInDriveTrash ? `${(Number(q.usageInDriveTrash) / 1073741824).toFixed(2)} GB` : "0", rawBytes: q }, maxUploadSize: r.data.maxUploadSize, importFormats: r.data.importFormats, exportFormats: r.data.exportFormats });
  } catch (e) { er(res, e); }
});

// ===== WORKSPACE CREATION =====
app.post("/api/docs", async (req: Request, res: Response) => {
  try { const md: drive_v3.Schema$File = { name: req.body.name, mimeType: "application/vnd.google-apps.document" }; if (req.body.parentId) md.parents = [req.body.parentId]; ok(res, (await drive.files.create({ requestBody: md, supportsAllDrives: true, fields: "id,name,mimeType,webViewLink" })).data); } catch (e) { er(res, e); }
});
app.post("/api/sheets", async (req: Request, res: Response) => {
  try { const md: drive_v3.Schema$File = { name: req.body.name, mimeType: "application/vnd.google-apps.spreadsheet" }; if (req.body.parentId) md.parents = [req.body.parentId]; ok(res, (await drive.files.create({ requestBody: md, supportsAllDrives: true, fields: "id,name,mimeType,webViewLink" })).data); } catch (e) { er(res, e); }
});
app.post("/api/slides", async (req: Request, res: Response) => {
  try { const md: drive_v3.Schema$File = { name: req.body.name, mimeType: "application/vnd.google-apps.presentation" }; if (req.body.parentId) md.parents = [req.body.parentId]; ok(res, (await drive.files.create({ requestBody: md, supportsAllDrives: true, fields: "id,name,mimeType,webViewLink" })).data); } catch (e) { er(res, e); }
});

// ===== SCHEMA + HEALTH =====
app.get("/health", (_r, res) => { res.json({ status: "ok", service: "chatgpt-google-drive-connector", version: "2.0.0", endpoints: 54 }); });

const BASE_URL = process.env.BASE_URL || "https://enchanting-insight-production-912a.up.railway.app";
const SCHEMA = buildSchema(BASE_URL);
app.get("/.well-known/openapi.yaml", (_r, res) => { res.setHeader("Content-Type", "text/yaml"); res.send(SCHEMA); });
app.get("/openapi.yaml", (_r, res) => { res.setHeader("Content-Type", "text/yaml"); res.send(SCHEMA); });

const PORT = parseInt(process.env.PORT ?? "3000", 10);
app.listen(PORT, () => console.error(`ChatGPT Google Drive Connector v2.0.0 (54 endpoints) on port ${PORT}`));

function buildSchema(base: string): string {
  return `openapi: 3.1.0
info:
  title: Google Drive Connector
  description: Complete Google Drive API - files, folders, permissions, comments, replies, revisions, shared drives, changes, and utilities.
  version: 2.0.0
servers:
  - url: ${base}
paths:
  /api/files:
    get:
      operationId: listFiles
      summary: List files in Google Drive with optional filters
      parameters:
        - {name: query, in: query, schema: {type: string}, description: Drive query string}
        - {name: folderId, in: query, schema: {type: string}, description: Filter to folder}
        - {name: mimeType, in: query, schema: {type: string}, description: Filter by MIME}
        - {name: pageSize, in: query, schema: {type: integer, default: 50}}
        - {name: pageToken, in: query, schema: {type: string}}
        - {name: orderBy, in: query, schema: {type: string}}
        - {name: trashed, in: query, schema: {type: string, default: "false"}}
      responses: {"200": {description: Files list}}
    post:
      operationId: createFile
      summary: Create a new file with optional content
      requestBody: {required: true, content: {application/json: {schema: {type: object, required: [name], properties: {name: {type: string}, mimeType: {type: string}, content: {type: string}, contentEncoding: {type: string, enum: [utf8, base64]}, parentId: {type: string}, description: {type: string}}}}}}
      responses: {"200": {description: Created file}}
  /api/files/search:
    get:
      operationId: searchFiles
      summary: Full-text search across Drive
      parameters:
        - {name: query, in: query, required: true, schema: {type: string}}
        - {name: pageSize, in: query, schema: {type: integer, default: 20}}
        - {name: pageToken, in: query, schema: {type: string}}
      responses: {"200": {description: Results}}
  /api/files/duplicates:
    get:
      operationId: findDuplicates
      summary: Find files with same name
      parameters:
        - {name: name, in: query, required: true, schema: {type: string}}
        - {name: folderId, in: query, schema: {type: string}}
      responses: {"200": {description: Duplicates}}
  /api/files/generate-ids:
    post:
      operationId: generateFileIds
      summary: Generate file IDs for future creates
      requestBody: {content: {application/json: {schema: {type: object, properties: {count: {type: integer, default: 10}}}}}}
      responses: {"200": {description: Generated IDs}}
  /api/files/empty-trash:
    post:
      operationId: emptyTrash
      summary: Permanently delete all trashed files (IRREVERSIBLE)
      responses: {"200": {description: Trash emptied}}
  /api/files/{fileId}:
    get:
      operationId: getFile
      summary: Get file metadata
      parameters: [{name: fileId, in: path, required: true, schema: {type: string}}]
      responses: {"200": {description: File metadata}}
    patch:
      operationId: updateFileMetadata
      summary: Update file name/description/starred
      parameters: [{name: fileId, in: path, required: true, schema: {type: string}}]
      requestBody: {content: {application/json: {schema: {type: object, properties: {name: {type: string}, description: {type: string}, starred: {type: boolean}}}}}}
      responses: {"200": {description: Updated}}
    delete:
      operationId: deleteFile
      summary: Permanently delete file (IRREVERSIBLE)
      parameters: [{name: fileId, in: path, required: true, schema: {type: string}}]
      responses: {"200": {description: Deleted}}
  /api/files/{fileId}/content:
    get:
      operationId: downloadFile
      summary: Download file content
      parameters:
        - {name: fileId, in: path, required: true, schema: {type: string}}
        - {name: encoding, in: query, schema: {type: string, enum: [utf8, base64], default: utf8}}
      responses: {"200": {description: Content}}
    put:
      operationId: updateFileContent
      summary: Overwrite file content
      parameters: [{name: fileId, in: path, required: true, schema: {type: string}}]
      requestBody: {required: true, content: {application/json: {schema: {type: object, required: [content], properties: {content: {type: string}, mimeType: {type: string}, contentEncoding: {type: string, enum: [utf8, base64]}}}}}}
      responses: {"200": {description: Updated}}
  /api/files/{fileId}/export:
    get:
      operationId: exportFile
      summary: Export Docs/Sheets/Slides to PDF/DOCX/etc
      parameters:
        - {name: fileId, in: path, required: true, schema: {type: string}}
        - {name: mimeType, in: query, required: true, schema: {type: string}}
      responses: {"200": {description: Exported}}
  /api/files/{fileId}/path:
    get:
      operationId: getFilePath
      summary: Get full folder path for a file
      parameters: [{name: fileId, in: path, required: true, schema: {type: string}}]
      responses: {"200": {description: Path}}
  /api/files/{fileId}/sharing-summary:
    get:
      operationId: getFileSharingSummary
      summary: Get sharing summary with all permissions
      parameters: [{name: fileId, in: path, required: true, schema: {type: string}}]
      responses: {"200": {description: Summary}}
  /api/files/{fileId}/copy:
    post:
      operationId: copyFile
      summary: Copy a file
      parameters: [{name: fileId, in: path, required: true, schema: {type: string}}]
      requestBody: {content: {application/json: {schema: {type: object, properties: {name: {type: string}, parentId: {type: string}}}}}}
      responses: {"200": {description: Copied}}
  /api/files/{fileId}/move:
    post:
      operationId: moveFile
      summary: Move file to different folder
      parameters: [{name: fileId, in: path, required: true, schema: {type: string}}]
      requestBody: {required: true, content: {application/json: {schema: {type: object, required: [newParentId], properties: {newParentId: {type: string}}}}}}
      responses: {"200": {description: Moved}}
  /api/files/{fileId}/trash:
    post:
      operationId: trashFile
      summary: Move to trash (recoverable)
      parameters: [{name: fileId, in: path, required: true, schema: {type: string}}]
      responses: {"200": {description: Trashed}}
  /api/files/{fileId}/restore:
    post:
      operationId: restoreFile
      summary: Restore from trash
      parameters: [{name: fileId, in: path, required: true, schema: {type: string}}]
      responses: {"200": {description: Restored}}
  /api/files/{fileId}/watch:
    post:
      operationId: watchFile
      summary: Subscribe to file change notifications
      parameters: [{name: fileId, in: path, required: true, schema: {type: string}}]
      requestBody: {required: true, content: {application/json: {schema: {type: object, required: [channelId, webhookUrl], properties: {channelId: {type: string}, webhookUrl: {type: string}, expirationMs: {type: string}}}}}}
      responses: {"200": {description: Channel}}
  /api/files/{fileId}/permissions:
    get:
      operationId: listPermissions
      summary: List permissions on a file
      parameters: [{name: fileId, in: path, required: true, schema: {type: string}}]
      responses: {"200": {description: Permissions}}
    post:
      operationId: shareFile
      summary: Share a file
      parameters: [{name: fileId, in: path, required: true, schema: {type: string}}]
      requestBody: {required: true, content: {application/json: {schema: {type: object, required: [role, type], properties: {role: {type: string, enum: [reader, commenter, writer, fileOrganizer, organizer, owner]}, type: {type: string, enum: [user, group, domain, anyone]}, emailAddress: {type: string}, domain: {type: string}, expirationTime: {type: string}, sendNotificationEmail: {type: boolean}, transferOwnership: {type: boolean}}}}}}
      responses: {"200": {description: Permission created}}
  /api/files/{fileId}/permissions/{permissionId}:
    get:
      operationId: getPermission
      summary: Get specific permission details
      parameters:
        - {name: fileId, in: path, required: true, schema: {type: string}}
        - {name: permissionId, in: path, required: true, schema: {type: string}}
      responses: {"200": {description: Permission}}
    patch:
      operationId: updatePermission
      summary: Update permission role
      parameters:
        - {name: fileId, in: path, required: true, schema: {type: string}}
        - {name: permissionId, in: path, required: true, schema: {type: string}}
      requestBody: {required: true, content: {application/json: {schema: {type: object, required: [role], properties: {role: {type: string}, expirationTime: {type: string}, transferOwnership: {type: boolean}}}}}}
      responses: {"200": {description: Updated}}
    delete:
      operationId: deletePermission
      summary: Remove permission
      parameters:
        - {name: fileId, in: path, required: true, schema: {type: string}}
        - {name: permissionId, in: path, required: true, schema: {type: string}}
      responses: {"200": {description: Deleted}}
  /api/files/{fileId}/comments:
    get:
      operationId: listComments
      summary: List comments on a file
      parameters:
        - {name: fileId, in: path, required: true, schema: {type: string}}
        - {name: includeDeleted, in: query, schema: {type: string, default: "false"}}
        - {name: pageSize, in: query, schema: {type: integer, default: 50}}
      responses: {"200": {description: Comments}}
    post:
      operationId: createComment
      summary: Add a comment
      parameters: [{name: fileId, in: path, required: true, schema: {type: string}}]
      requestBody: {required: true, content: {application/json: {schema: {type: object, required: [content], properties: {content: {type: string}}}}}}
      responses: {"200": {description: Created}}
  /api/files/{fileId}/comments/{commentId}:
    get:
      operationId: getComment
      summary: Get a specific comment
      parameters:
        - {name: fileId, in: path, required: true, schema: {type: string}}
        - {name: commentId, in: path, required: true, schema: {type: string}}
      responses: {"200": {description: Comment}}
    patch:
      operationId: updateComment
      summary: Update comment content
      parameters:
        - {name: fileId, in: path, required: true, schema: {type: string}}
        - {name: commentId, in: path, required: true, schema: {type: string}}
      requestBody: {required: true, content: {application/json: {schema: {type: object, required: [content], properties: {content: {type: string}}}}}}
      responses: {"200": {description: Updated}}
    delete:
      operationId: deleteComment
      summary: Delete a comment
      parameters:
        - {name: fileId, in: path, required: true, schema: {type: string}}
        - {name: commentId, in: path, required: true, schema: {type: string}}
      responses: {"200": {description: Deleted}}
  /api/files/{fileId}/comments/{commentId}/replies:
    get:
      operationId: listReplies
      summary: List replies to a comment
      parameters:
        - {name: fileId, in: path, required: true, schema: {type: string}}
        - {name: commentId, in: path, required: true, schema: {type: string}}
      responses: {"200": {description: Replies}}
    post:
      operationId: createReply
      summary: Reply to a comment
      parameters:
        - {name: fileId, in: path, required: true, schema: {type: string}}
        - {name: commentId, in: path, required: true, schema: {type: string}}
      requestBody: {required: true, content: {application/json: {schema: {type: object, required: [content], properties: {content: {type: string}}}}}}
      responses: {"200": {description: Created}}
  /api/files/{fileId}/comments/{commentId}/replies/{replyId}:
    delete:
      operationId: deleteReply
      summary: Delete a reply
      parameters:
        - {name: fileId, in: path, required: true, schema: {type: string}}
        - {name: commentId, in: path, required: true, schema: {type: string}}
        - {name: replyId, in: path, required: true, schema: {type: string}}
      responses: {"200": {description: Deleted}}
  /api/files/{fileId}/revisions:
    get:
      operationId: listRevisions
      summary: List file revisions (version history)
      parameters:
        - {name: fileId, in: path, required: true, schema: {type: string}}
        - {name: pageSize, in: query, schema: {type: integer, default: 100}}
      responses: {"200": {description: Revisions}}
  /api/files/{fileId}/revisions/{revisionId}:
    get:
      operationId: getRevision
      summary: Get revision metadata
      parameters:
        - {name: fileId, in: path, required: true, schema: {type: string}}
        - {name: revisionId, in: path, required: true, schema: {type: string}}
      responses: {"200": {description: Revision}}
    patch:
      operationId: updateRevision
      summary: Update revision keepForever/published
      parameters:
        - {name: fileId, in: path, required: true, schema: {type: string}}
        - {name: revisionId, in: path, required: true, schema: {type: string}}
      requestBody: {content: {application/json: {schema: {type: object, properties: {keepForever: {type: boolean}, published: {type: boolean}}}}}}
      responses: {"200": {description: Updated}}
    delete:
      operationId: deleteRevision
      summary: Delete a revision
      parameters:
        - {name: fileId, in: path, required: true, schema: {type: string}}
        - {name: revisionId, in: path, required: true, schema: {type: string}}
      responses: {"200": {description: Deleted}}
  /api/folders:
    post:
      operationId: createFolder
      summary: Create a new folder
      requestBody: {required: true, content: {application/json: {schema: {type: object, required: [name], properties: {name: {type: string}, parentId: {type: string}, description: {type: string}}}}}}
      responses: {"200": {description: Folder}}
  /api/folders/{folderId}/contents:
    get:
      operationId: listFolderContents
      summary: List folder contents
      parameters:
        - {name: folderId, in: path, required: true, schema: {type: string}}
        - {name: pageSize, in: query, schema: {type: integer, default: 100}}
        - {name: pageToken, in: query, schema: {type: string}}
      responses: {"200": {description: Contents}}
  /api/folders/{folderId}/tree:
    get:
      operationId: getFolderTree
      summary: Recursive folder tree (max depth 5)
      parameters:
        - {name: folderId, in: path, required: true, schema: {type: string}}
        - {name: maxDepth, in: query, schema: {type: integer, default: 2}}
        - {name: includeFiles, in: query, schema: {type: string, default: "true"}}
      responses: {"200": {description: Tree}}
  /api/drives:
    get:
      operationId: listSharedDrives
      summary: List shared drives
      responses: {"200": {description: Drives}}
    post:
      operationId: createSharedDrive
      summary: Create a shared drive
      requestBody: {required: true, content: {application/json: {schema: {type: object, required: [name], properties: {name: {type: string}, requestId: {type: string}}}}}}
      responses: {"200": {description: Created}}
  /api/drives/{driveId}:
    get:
      operationId: getSharedDrive
      summary: Get shared drive info
      parameters: [{name: driveId, in: path, required: true, schema: {type: string}}]
      responses: {"200": {description: Drive}}
    patch:
      operationId: updateSharedDrive
      summary: Update shared drive name
      parameters: [{name: driveId, in: path, required: true, schema: {type: string}}]
      requestBody: {required: true, content: {application/json: {schema: {type: object, properties: {name: {type: string}}}}}}
      responses: {"200": {description: Updated}}
    delete:
      operationId: deleteSharedDrive
      summary: Delete empty shared drive
      parameters: [{name: driveId, in: path, required: true, schema: {type: string}}]
      responses: {"200": {description: Deleted}}
  /api/drives/{driveId}/hide:
    post:
      operationId: hideSharedDrive
      summary: Hide a shared drive
      parameters: [{name: driveId, in: path, required: true, schema: {type: string}}]
      responses: {"200": {description: Hidden}}
  /api/drives/{driveId}/unhide:
    post:
      operationId: unhideSharedDrive
      summary: Unhide a shared drive
      parameters: [{name: driveId, in: path, required: true, schema: {type: string}}]
      responses: {"200": {description: Unhidden}}
  /api/changes/start-page-token:
    get:
      operationId: getStartPageToken
      summary: Get start token for change tracking
      parameters:
        - {name: driveId, in: query, schema: {type: string}}
      responses: {"200": {description: Token}}
  /api/changes:
    get:
      operationId: listChanges
      summary: List file changes since a page token
      parameters:
        - {name: pageToken, in: query, required: true, schema: {type: string}}
        - {name: pageSize, in: query, schema: {type: integer, default: 100}}
        - {name: includeRemoved, in: query, schema: {type: string, default: "true"}}
      responses: {"200": {description: Changes}}
  /api/changes/watch:
    post:
      operationId: watchChanges
      summary: Subscribe to change notifications via webhook
      requestBody: {required: true, content: {application/json: {schema: {type: object, required: [pageToken, channelId, webhookUrl], properties: {pageToken: {type: string}, channelId: {type: string}, webhookUrl: {type: string}, expirationMs: {type: string}}}}}}
      responses: {"200": {description: Channel}}
  /api/channels/stop:
    post:
      operationId: stopChannel
      summary: Stop a push notification channel
      requestBody: {required: true, content: {application/json: {schema: {type: object, required: [channelId, resourceId], properties: {channelId: {type: string}, resourceId: {type: string}}}}}}
      responses: {"200": {description: Stopped}}
  /api/about:
    get:
      operationId: getAbout
      summary: Get user info, storage quota, and supported formats
      responses: {"200": {description: About info}}
  /api/docs:
    post:
      operationId: createGoogleDoc
      summary: Create a new Google Doc
      requestBody: {required: true, content: {application/json: {schema: {type: object, required: [name], properties: {name: {type: string}, parentId: {type: string}}}}}}
      responses: {"200": {description: Doc}}
  /api/sheets:
    post:
      operationId: createGoogleSheet
      summary: Create a new Google Sheet
      requestBody: {required: true, content: {application/json: {schema: {type: object, required: [name], properties: {name: {type: string}, parentId: {type: string}}}}}}
      responses: {"200": {description: Sheet}}
  /api/slides:
    post:
      operationId: createGoogleSlides
      summary: Create a new Google Slides presentation
      requestBody: {required: true, content: {application/json: {schema: {type: object, required: [name], properties: {name: {type: string}, parentId: {type: string}}}}}}
      responses: {"200": {description: Slides}}
components:
  securitySchemes:
    ApiKeyAuth:
      type: apiKey
      in: header
      name: x-api-key
security:
  - ApiKeyAuth: []
`;
}
