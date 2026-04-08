import express, { Request, Response, NextFunction } from "express";
import cors from "cors";
import { drive as createDrive, drive_v3 } from "@googleapis/drive";
import { OAuth2Client } from "google-auth-library";

const app = express();
app.use(cors());
app.use(express.json({ limit: "10mb" }));

// --- Auth ---
const clientId = process.env.GOOGLE_CLIENT_ID!;
const clientSecret = process.env.GOOGLE_CLIENT_SECRET!;
const refreshToken = process.env.GOOGLE_REFRESH_TOKEN!;
const API_KEY = process.env.API_KEY || "changeme";

if (!clientId || !clientSecret || !refreshToken) {
  console.error("Missing GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, or GOOGLE_REFRESH_TOKEN");
  process.exit(1);
}

const auth = new OAuth2Client(clientId, clientSecret);
auth.setCredentials({ refresh_token: refreshToken });
const drive: drive_v3.Drive = createDrive({ version: "v3", auth });

// API Key middleware
function requireApiKey(req: Request, res: Response, next: NextFunction): void {
  const key = req.headers["x-api-key"] || req.headers["authorization"]?.replace("Bearer ", "");
  if (key !== API_KEY) {
    res.status(401).json({ error: "Invalid or missing API key" });
    return;
  }
  next();
}

app.use("/api", requireApiKey);

// --- Helper ---
function ok(res: Response, data: unknown) {
  res.json(data);
}
function err(res: Response, e: unknown) {
  const msg = e instanceof Error ? e.message : String(e);
  res.status(500).json({ error: msg });
}

// ===================== FILES =====================

// List files
app.get("/api/files", async (req: Request, res: Response) => {
  try {
    const { query, folderId, mimeType, pageSize, pageToken, orderBy, trashed } = req.query;
    const parts: string[] = [];
    if (folderId) parts.push(`'${folderId}' in parents`);
    if (mimeType) parts.push(`mimeType='${mimeType}'`);
    parts.push(`trashed=${trashed === "true"}`);
    if (query) parts.push(query as string);
    const q = parts.join(" and ");
    const r = await drive.files.list({
      q, pageSize: Number(pageSize) || 50, pageToken: pageToken as string, orderBy: orderBy as string,
      supportsAllDrives: true, includeItemsFromAllDrives: true,
      fields: "nextPageToken,files(id,name,mimeType,size,modifiedTime,createdTime,parents,webViewLink,shared,starred,trashed,owners)"
    });
    ok(res, { files: r.data.files, nextPageToken: r.data.nextPageToken });
  } catch (e) { err(res, e); }
});

// Search files
app.get("/api/files/search", async (req: Request, res: Response) => {
  try {
    const { query, pageSize, pageToken } = req.query;
    const r = await drive.files.list({
      q: query as string, pageSize: Number(pageSize) || 20, pageToken: pageToken as string,
      supportsAllDrives: true, includeItemsFromAllDrives: true,
      fields: "nextPageToken,files(id,name,mimeType,size,modifiedTime,webViewLink,parents)"
    });
    ok(res, { files: r.data.files, nextPageToken: r.data.nextPageToken });
  } catch (e) { err(res, e); }
});

// Get file metadata
app.get("/api/files/:fileId", async (req: Request, res: Response) => {
  try {
    const r = await drive.files.get({ fileId: req.params.fileId, fields: "*", supportsAllDrives: true });
    ok(res, r.data);
  } catch (e) { err(res, e); }
});

// Download file content
app.get("/api/files/:fileId/content", async (req: Request, res: Response) => {
  try {
    const r = await drive.files.get({ fileId: req.params.fileId, alt: "media", supportsAllDrives: true }, { responseType: "arraybuffer" });
    const buf = Buffer.from(r.data as ArrayBuffer);
    const encoding = req.query.encoding === "base64" ? "base64" : "utf8";
    ok(res, { content: buf.toString(encoding), encoding, size: buf.length });
  } catch (e) { err(res, e); }
});

// Export Google Workspace file
app.get("/api/files/:fileId/export", async (req: Request, res: Response) => {
  try {
    const mimeType = req.query.mimeType as string;
    const r = await drive.files.export({ fileId: req.params.fileId, mimeType }, { responseType: "arraybuffer" });
    const buf = Buffer.from(r.data as ArrayBuffer);
    const isText = mimeType?.startsWith("text/");
    ok(res, { content: buf.toString(isText ? "utf8" : "base64"), mimeType, encoding: isText ? "utf8" : "base64", size: buf.length });
  } catch (e) { err(res, e); }
});

// Create file
app.post("/api/files", async (req: Request, res: Response) => {
  try {
    const { name, mimeType, content, contentEncoding, parentId, description } = req.body;
    const metadata: drive_v3.Schema$File = { name, mimeType: mimeType || "text/plain", description };
    if (parentId) metadata.parents = [parentId];
    let media: { mimeType: string; body: Buffer | string } | undefined;
    if (content) {
      const body = contentEncoding === "base64" ? Buffer.from(content, "base64") : content;
      media = { mimeType: mimeType || "text/plain", body };
    }
    const r = await drive.files.create({ requestBody: metadata, media, supportsAllDrives: true, fields: "id,name,mimeType,webViewLink,parents,createdTime" });
    ok(res, r.data);
  } catch (e) { err(res, e); }
});

// Update file metadata
app.patch("/api/files/:fileId", async (req: Request, res: Response) => {
  try {
    const { name, description, starred } = req.body;
    const requestBody: drive_v3.Schema$File = {};
    if (name !== undefined) requestBody.name = name;
    if (description !== undefined) requestBody.description = description;
    if (starred !== undefined) requestBody.starred = starred;
    const r = await drive.files.update({ fileId: req.params.fileId, requestBody, supportsAllDrives: true, fields: "id,name,description,starred,modifiedTime" });
    ok(res, r.data);
  } catch (e) { err(res, e); }
});

// Update file content
app.put("/api/files/:fileId/content", async (req: Request, res: Response) => {
  try {
    const { content, mimeType, contentEncoding } = req.body;
    const body = contentEncoding === "base64" ? Buffer.from(content, "base64") : content;
    const r = await drive.files.update({ fileId: req.params.fileId, requestBody: {}, media: { mimeType: mimeType || "text/plain", body }, supportsAllDrives: true, fields: "id,name,size,modifiedTime" });
    ok(res, r.data);
  } catch (e) { err(res, e); }
});

// Copy file
app.post("/api/files/:fileId/copy", async (req: Request, res: Response) => {
  try {
    const { name, parentId } = req.body;
    const requestBody: drive_v3.Schema$File = {};
    if (name) requestBody.name = name;
    if (parentId) requestBody.parents = [parentId];
    const r = await drive.files.copy({ fileId: req.params.fileId, requestBody, supportsAllDrives: true, fields: "id,name,mimeType,webViewLink,parents" });
    ok(res, r.data);
  } catch (e) { err(res, e); }
});

// Move file
app.post("/api/files/:fileId/move", async (req: Request, res: Response) => {
  try {
    const { newParentId } = req.body;
    const current = await drive.files.get({ fileId: req.params.fileId, fields: "parents", supportsAllDrives: true });
    const oldParents = (current.data.parents || []).join(",");
    const r = await drive.files.update({ fileId: req.params.fileId, addParents: newParentId, removeParents: oldParents, requestBody: {}, supportsAllDrives: true, fields: "id,name,parents" });
    ok(res, r.data);
  } catch (e) { err(res, e); }
});

// Trash file
app.post("/api/files/:fileId/trash", async (req: Request, res: Response) => {
  try {
    const r = await drive.files.update({ fileId: req.params.fileId, requestBody: { trashed: true }, supportsAllDrives: true, fields: "id,name,trashed" });
    ok(res, r.data);
  } catch (e) { err(res, e); }
});

// Restore file
app.post("/api/files/:fileId/restore", async (req: Request, res: Response) => {
  try {
    const r = await drive.files.update({ fileId: req.params.fileId, requestBody: { trashed: false }, supportsAllDrives: true, fields: "id,name,trashed" });
    ok(res, r.data);
  } catch (e) { err(res, e); }
});

// Delete file permanently
app.delete("/api/files/:fileId", async (req: Request, res: Response) => {
  try {
    await drive.files.delete({ fileId: req.params.fileId, supportsAllDrives: true });
    ok(res, { deleted: true, fileId: req.params.fileId });
  } catch (e) { err(res, e); }
});

// ===================== FOLDERS =====================

// Create folder
app.post("/api/folders", async (req: Request, res: Response) => {
  try {
    const { name, parentId, description } = req.body;
    const metadata: drive_v3.Schema$File = { name, mimeType: "application/vnd.google-apps.folder", description };
    if (parentId) metadata.parents = [parentId];
    const r = await drive.files.create({ requestBody: metadata, supportsAllDrives: true, fields: "id,name,mimeType,parents,webViewLink,createdTime" });
    ok(res, r.data);
  } catch (e) { err(res, e); }
});

// List folder contents
app.get("/api/folders/:folderId/contents", async (req: Request, res: Response) => {
  try {
    const { pageSize, pageToken } = req.query;
    const r = await drive.files.list({
      q: `'${req.params.folderId}' in parents and trashed=false`,
      pageSize: Number(pageSize) || 100, pageToken: pageToken as string,
      supportsAllDrives: true, includeItemsFromAllDrives: true,
      orderBy: "folder,name",
      fields: "nextPageToken,files(id,name,mimeType,size,modifiedTime,webViewLink,shared)"
    });
    ok(res, { files: r.data.files, nextPageToken: r.data.nextPageToken });
  } catch (e) { err(res, e); }
});

// ===================== PERMISSIONS =====================

// List permissions
app.get("/api/files/:fileId/permissions", async (req: Request, res: Response) => {
  try {
    const r = await drive.permissions.list({
      fileId: req.params.fileId, supportsAllDrives: true,
      fields: "permissions(id,type,role,emailAddress,domain,displayName)"
    });
    ok(res, { permissions: r.data.permissions });
  } catch (e) { err(res, e); }
});

// Create permission (share)
app.post("/api/files/:fileId/permissions", async (req: Request, res: Response) => {
  try {
    const { role, type, emailAddress, domain, sendNotificationEmail } = req.body;
    const requestBody: drive_v3.Schema$Permission = { role, type };
    if (emailAddress) requestBody.emailAddress = emailAddress;
    if (domain) requestBody.domain = domain;
    const r = await drive.permissions.create({
      fileId: req.params.fileId, requestBody,
      sendNotificationEmail: sendNotificationEmail !== false,
      supportsAllDrives: true,
      fields: "id,type,role,emailAddress,displayName"
    });
    ok(res, r.data);
  } catch (e) { err(res, e); }
});

// Delete permission
app.delete("/api/files/:fileId/permissions/:permissionId", async (req: Request, res: Response) => {
  try {
    await drive.permissions.delete({ fileId: req.params.fileId, permissionId: req.params.permissionId, supportsAllDrives: true });
    ok(res, { deleted: true });
  } catch (e) { err(res, e); }
});

// ===================== COMMENTS =====================

// List comments
app.get("/api/files/:fileId/comments", async (req: Request, res: Response) => {
  try {
    const r = await drive.comments.list({
      fileId: req.params.fileId, pageSize: 50,
      fields: "comments(id,content,author,createdTime,resolved,replies)"
    });
    ok(res, { comments: r.data.comments });
  } catch (e) { err(res, e); }
});

// Create comment
app.post("/api/files/:fileId/comments", async (req: Request, res: Response) => {
  try {
    const r = await drive.comments.create({
      fileId: req.params.fileId,
      requestBody: { content: req.body.content },
      fields: "id,content,author,createdTime"
    });
    ok(res, r.data);
  } catch (e) { err(res, e); }
});

// ===================== SHARED DRIVES =====================

// List shared drives
app.get("/api/drives", async (req: Request, res: Response) => {
  try {
    const r = await drive.drives.list({ pageSize: 100, fields: "drives(id,name,createdTime)" });
    ok(res, { drives: r.data.drives });
  } catch (e) { err(res, e); }
});

// ===================== ABOUT =====================

// Get storage info
app.get("/api/about", async (req: Request, res: Response) => {
  try {
    const r = await drive.about.get({ fields: "user,storageQuota" });
    const q = r.data.storageQuota;
    ok(res, {
      user: r.data.user,
      storageQuota: {
        limit: q?.limit ? `${(Number(q.limit) / 1073741824).toFixed(2)} GB` : "unlimited",
        usage: q?.usage ? `${(Number(q.usage) / 1073741824).toFixed(2)} GB` : "0",
        usageInDrive: q?.usageInDrive ? `${(Number(q.usageInDrive) / 1073741824).toFixed(2)} GB` : "0",
        usageInDriveTrash: q?.usageInDriveTrash ? `${(Number(q.usageInDriveTrash) / 1073741824).toFixed(2)} GB` : "0"
      }
    });
  } catch (e) { err(res, e); }
});

// ===================== GOOGLE WORKSPACE CREATION =====================

app.post("/api/docs", async (req: Request, res: Response) => {
  try {
    const { name, parentId } = req.body;
    const metadata: drive_v3.Schema$File = { name, mimeType: "application/vnd.google-apps.document" };
    if (parentId) metadata.parents = [parentId];
    const r = await drive.files.create({ requestBody: metadata, supportsAllDrives: true, fields: "id,name,mimeType,webViewLink" });
    ok(res, r.data);
  } catch (e) { err(res, e); }
});

app.post("/api/sheets", async (req: Request, res: Response) => {
  try {
    const { name, parentId } = req.body;
    const metadata: drive_v3.Schema$File = { name, mimeType: "application/vnd.google-apps.spreadsheet" };
    if (parentId) metadata.parents = [parentId];
    const r = await drive.files.create({ requestBody: metadata, supportsAllDrives: true, fields: "id,name,mimeType,webViewLink" });
    ok(res, r.data);
  } catch (e) { err(res, e); }
});

app.post("/api/slides", async (req: Request, res: Response) => {
  try {
    const { name, parentId } = req.body;
    const metadata: drive_v3.Schema$File = { name, mimeType: "application/vnd.google-apps.presentation" };
    if (parentId) metadata.parents = [parentId];
    const r = await drive.files.create({ requestBody: metadata, supportsAllDrives: true, fields: "id,name,mimeType,webViewLink" });
    ok(res, r.data);
  } catch (e) { err(res, e); }
});

// ===================== OPENAPI SCHEMA =====================

app.get("/.well-known/openapi.yaml", (_req: Request, res: Response) => {
  res.setHeader("Content-Type", "text/yaml");
  res.send(OPENAPI_SCHEMA);
});

app.get("/openapi.yaml", (_req: Request, res: Response) => {
  res.setHeader("Content-Type", "text/yaml");
  res.send(OPENAPI_SCHEMA);
});

// Health
app.get("/health", (_req, res) => {
  res.json({ status: "ok", service: "chatgpt-google-drive-connector", version: "1.0.0" });
});

// ===================== START =====================

const PORT = parseInt(process.env.PORT ?? "3000", 10);
app.listen(PORT, () => {
  console.error(`ChatGPT Google Drive Connector running on port ${PORT}`);
});

// ===================== OPENAPI SPEC =====================

const BASE_URL = process.env.BASE_URL || "https://chatgpt-google-drive-connector-production.up.railway.app";

const OPENAPI_SCHEMA = `openapi: 3.1.0
info:
  title: Google Drive Connector
  description: Full Google Drive access - list, search, read, create, edit, share, and manage files, folders, permissions, comments, and shared drives.
  version: 1.0.0
servers:
  - url: ${BASE_URL}
paths:
  /api/files:
    get:
      operationId: listFiles
      summary: List files in Google Drive
      parameters:
        - name: query
          in: query
          schema: { type: string }
          description: Google Drive query string
        - name: folderId
          in: query
          schema: { type: string }
          description: Filter to files in this folder
        - name: mimeType
          in: query
          schema: { type: string }
          description: Filter by MIME type
        - name: pageSize
          in: query
          schema: { type: integer, default: 50 }
        - name: pageToken
          in: query
          schema: { type: string }
        - name: orderBy
          in: query
          schema: { type: string }
          description: Sort order e.g. modifiedTime desc
        - name: trashed
          in: query
          schema: { type: string, default: "false" }
      responses:
        "200":
          description: List of files
    post:
      operationId: createFile
      summary: Create a new file
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              required: [name]
              properties:
                name: { type: string }
                mimeType: { type: string, default: text/plain }
                content: { type: string }
                contentEncoding: { type: string, enum: [utf8, base64], default: utf8 }
                parentId: { type: string }
                description: { type: string }
      responses:
        "200":
          description: Created file
  /api/files/search:
    get:
      operationId: searchFiles
      summary: Full-text search across Drive
      parameters:
        - name: query
          in: query
          required: true
          schema: { type: string }
          description: Search query e.g. fullText contains 'budget'
        - name: pageSize
          in: query
          schema: { type: integer, default: 20 }
        - name: pageToken
          in: query
          schema: { type: string }
      responses:
        "200":
          description: Search results
  /api/files/{fileId}:
    get:
      operationId: getFile
      summary: Get file metadata
      parameters:
        - name: fileId
          in: path
          required: true
          schema: { type: string }
      responses:
        "200":
          description: File metadata
    patch:
      operationId: updateFileMetadata
      summary: Update file name, description, or starred status
      parameters:
        - name: fileId
          in: path
          required: true
          schema: { type: string }
      requestBody:
        content:
          application/json:
            schema:
              type: object
              properties:
                name: { type: string }
                description: { type: string }
                starred: { type: boolean }
      responses:
        "200":
          description: Updated file
    delete:
      operationId: deleteFile
      summary: Permanently delete a file (IRREVERSIBLE)
      parameters:
        - name: fileId
          in: path
          required: true
          schema: { type: string }
      responses:
        "200":
          description: Deletion result
  /api/files/{fileId}/content:
    get:
      operationId: downloadFile
      summary: Download file content (use export for Google Docs/Sheets/Slides)
      parameters:
        - name: fileId
          in: path
          required: true
          schema: { type: string }
        - name: encoding
          in: query
          schema: { type: string, enum: [utf8, base64], default: utf8 }
      responses:
        "200":
          description: File content
    put:
      operationId: updateFileContent
      summary: Overwrite file content
      parameters:
        - name: fileId
          in: path
          required: true
          schema: { type: string }
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              required: [content]
              properties:
                content: { type: string }
                mimeType: { type: string, default: text/plain }
                contentEncoding: { type: string, enum: [utf8, base64], default: utf8 }
      responses:
        "200":
          description: Updated file
  /api/files/{fileId}/export:
    get:
      operationId: exportFile
      summary: Export Google Docs/Sheets/Slides to PDF, DOCX, etc.
      parameters:
        - name: fileId
          in: path
          required: true
          schema: { type: string }
        - name: mimeType
          in: query
          required: true
          schema: { type: string }
          description: Export MIME type e.g. application/pdf
      responses:
        "200":
          description: Exported content
  /api/files/{fileId}/copy:
    post:
      operationId: copyFile
      summary: Copy a file
      parameters:
        - name: fileId
          in: path
          required: true
          schema: { type: string }
      requestBody:
        content:
          application/json:
            schema:
              type: object
              properties:
                name: { type: string }
                parentId: { type: string }
      responses:
        "200":
          description: Copied file
  /api/files/{fileId}/move:
    post:
      operationId: moveFile
      summary: Move a file to a different folder
      parameters:
        - name: fileId
          in: path
          required: true
          schema: { type: string }
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              required: [newParentId]
              properties:
                newParentId: { type: string }
      responses:
        "200":
          description: Moved file
  /api/files/{fileId}/trash:
    post:
      operationId: trashFile
      summary: Move file to trash (recoverable)
      parameters:
        - name: fileId
          in: path
          required: true
          schema: { type: string }
      responses:
        "200":
          description: Trashed file
  /api/files/{fileId}/restore:
    post:
      operationId: restoreFile
      summary: Restore a file from trash
      parameters:
        - name: fileId
          in: path
          required: true
          schema: { type: string }
      responses:
        "200":
          description: Restored file
  /api/files/{fileId}/permissions:
    get:
      operationId: listPermissions
      summary: List sharing permissions on a file
      parameters:
        - name: fileId
          in: path
          required: true
          schema: { type: string }
      responses:
        "200":
          description: Permissions list
    post:
      operationId: shareFile
      summary: Share a file with a user, group, domain, or anyone
      parameters:
        - name: fileId
          in: path
          required: true
          schema: { type: string }
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              required: [role, type]
              properties:
                role: { type: string, enum: [reader, commenter, writer, fileOrganizer, organizer, owner] }
                type: { type: string, enum: [user, group, domain, anyone] }
                emailAddress: { type: string }
                domain: { type: string }
                sendNotificationEmail: { type: boolean, default: true }
      responses:
        "200":
          description: Created permission
  /api/files/{fileId}/permissions/{permissionId}:
    delete:
      operationId: deletePermission
      summary: Remove sharing permission
      parameters:
        - name: fileId
          in: path
          required: true
          schema: { type: string }
        - name: permissionId
          in: path
          required: true
          schema: { type: string }
      responses:
        "200":
          description: Deleted
  /api/files/{fileId}/comments:
    get:
      operationId: listComments
      summary: List comments on a file
      parameters:
        - name: fileId
          in: path
          required: true
          schema: { type: string }
      responses:
        "200":
          description: Comments list
    post:
      operationId: createComment
      summary: Add a comment to a file
      parameters:
        - name: fileId
          in: path
          required: true
          schema: { type: string }
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              required: [content]
              properties:
                content: { type: string }
      responses:
        "200":
          description: Created comment
  /api/folders:
    post:
      operationId: createFolder
      summary: Create a new folder
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              required: [name]
              properties:
                name: { type: string }
                parentId: { type: string }
                description: { type: string }
      responses:
        "200":
          description: Created folder
  /api/folders/{folderId}/contents:
    get:
      operationId: listFolderContents
      summary: List files and subfolders inside a folder
      parameters:
        - name: folderId
          in: path
          required: true
          schema: { type: string }
          description: Folder ID (use 'root' for My Drive root)
        - name: pageSize
          in: query
          schema: { type: integer, default: 100 }
        - name: pageToken
          in: query
          schema: { type: string }
      responses:
        "200":
          description: Folder contents
  /api/drives:
    get:
      operationId: listSharedDrives
      summary: List shared drives
      responses:
        "200":
          description: Shared drives list
  /api/about:
    get:
      operationId: getAbout
      summary: Get user info and storage quota
      responses:
        "200":
          description: User and storage info
  /api/docs:
    post:
      operationId: createGoogleDoc
      summary: Create a new Google Doc
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              required: [name]
              properties:
                name: { type: string }
                parentId: { type: string }
      responses:
        "200":
          description: Created Google Doc
  /api/sheets:
    post:
      operationId: createGoogleSheet
      summary: Create a new Google Sheet
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              required: [name]
              properties:
                name: { type: string }
                parentId: { type: string }
      responses:
        "200":
          description: Created Google Sheet
  /api/slides:
    post:
      operationId: createGoogleSlides
      summary: Create a new Google Slides presentation
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              required: [name]
              properties:
                name: { type: string }
                parentId: { type: string }
      responses:
        "200":
          description: Created Google Slides
components:
  securitySchemes:
    ApiKeyAuth:
      type: apiKey
      in: header
      name: x-api-key
security:
  - ApiKeyAuth: []
`;
