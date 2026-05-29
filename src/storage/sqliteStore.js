import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { createRequire } from "node:module";
import { prepareDbForStorage, prepareDbFromStorage } from "../services/tokenStorage.js";

const require = createRequire(import.meta.url);
const SCHEMA_VERSION = 2;

function json(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  return JSON.stringify(value);
}

function parse(value, fallback) {
  if (!value) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function siteScopedId(siteId, id) {
  if (String(id || "").startsWith(`${siteId}:`)) return id;
  return `${siteId}:${id}`;
}

function publicId(siteId, id) {
  const prefix = `${siteId}:`;
  return String(id || "").startsWith(prefix) ? String(id).slice(prefix.length) : id;
}

function createIfNotExists(sql) {
  return sql.replace(/CREATE TABLE\s+/u, "CREATE TABLE IF NOT EXISTS ");
}

export function createSqliteStore(dbPath, initialDb, env = process.env) {
  const { DatabaseSync } = require("node:sqlite");
  mkdirSync(dirname(dbPath), { recursive: true });
  const database = new DatabaseSync(dbPath);

  const createFieldMappingsSql = `
    CREATE TABLE field_mappings (
      id TEXT NOT NULL,
      site_id TEXT NOT NULL,
      wix_field TEXT NOT NULL,
      hubspot_property TEXT NOT NULL,
      direction TEXT NOT NULL,
      transform TEXT NOT NULL,
      PRIMARY KEY (id, site_id)
    )`;
  const createContactMappingsSql = `
    CREATE TABLE contact_mappings (
      id TEXT NOT NULL,
      site_id TEXT NOT NULL,
      wix_contact_id TEXT,
      hubspot_contact_id TEXT,
      last_sync_id TEXT,
      processed_sync_ids TEXT NOT NULL,
      last_wix_updated_at TEXT,
      last_hubspot_updated_at TEXT,
      created_at TEXT,
      updated_at TEXT,
      PRIMARY KEY (id, site_id)
    )`;
  const createProcessedEventsSql = `
    CREATE TABLE processed_events (
      id TEXT NOT NULL,
      site_id TEXT NOT NULL,
      source TEXT NOT NULL,
      processed_at TEXT NOT NULL,
      PRIMARY KEY (id, site_id)
    )`;
  const createWebhookRegistrationsSql = `
    CREATE TABLE webhook_registrations (
      provider TEXT NOT NULL,
      site_id TEXT NOT NULL,
      status TEXT NOT NULL,
      mode TEXT,
      registered_at TEXT,
      message TEXT,
      data TEXT NOT NULL,
      PRIMARY KEY (provider, site_id)
    )`;
  const createPollingCheckpointsSql = `
    CREATE TABLE polling_checkpoints (
      provider TEXT NOT NULL,
      site_id TEXT NOT NULL,
      status TEXT NOT NULL,
      last_poll_started_at TEXT,
      last_poll_completed_at TEXT,
      last_successful_poll_at TEXT,
      last_modified_after TEXT,
      last_seen_modified_at TEXT,
      last_error TEXT,
      updated_at TEXT NOT NULL,
      data TEXT NOT NULL,
      PRIMARY KEY (provider, site_id)
    )`;

  database.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS installations (
      id TEXT PRIMARY KEY,
      site_id TEXT NOT NULL,
      data TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS hubspot_connections (
      id TEXT PRIMARY KEY,
      site_id TEXT NOT NULL,
      connected INTEGER NOT NULL,
      portal_id TEXT,
      data TEXT NOT NULL
    );
    ${createIfNotExists(createFieldMappingsSql)};
    ${createIfNotExists(createContactMappingsSql)};
    ${createIfNotExists(createProcessedEventsSql)};
    CREATE TABLE IF NOT EXISTS sync_events (
      id TEXT PRIMARY KEY,
      site_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      source TEXT,
      sync_id TEXT,
      status TEXT,
      message TEXT,
      details TEXT
    );
    CREATE TABLE IF NOT EXISTS form_submissions (
      id TEXT PRIMARY KEY,
      site_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      form_id TEXT,
      data TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS oauth_states (
      state TEXT PRIMARY KEY,
      site_id TEXT NOT NULL,
      install_id TEXT,
      redirect_to TEXT,
      created_at TEXT NOT NULL,
      consumed_at TEXT
    );
    ${createIfNotExists(createWebhookRegistrationsSql)};
    ${createIfNotExists(createPollingCheckpointsSql)};
    CREATE TABLE IF NOT EXISTS retry_jobs (
      id TEXT PRIMARY KEY,
      site_id TEXT NOT NULL,
      direction TEXT NOT NULL,
      sync_id TEXT,
      status TEXT NOT NULL,
      attempts INTEGER NOT NULL,
      next_attempt_at TEXT,
      last_error TEXT,
      permanent INTEGER NOT NULL,
      payload TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS mock_hubspot_contacts (
      id TEXT PRIMARY KEY,
      site_id TEXT NOT NULL DEFAULT 'default-site',
      data TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS mock_wix_contacts (
      id TEXT PRIMARY KEY,
      site_id TEXT NOT NULL DEFAULT 'default-site',
      data TEXT NOT NULL
    );
  `);

  function tableInfo(name) {
    return database.prepare(`PRAGMA table_info(${name})`).all();
  }

  function hasColumn(table, column) {
    return tableInfo(table).some((row) => row.name === column);
  }

  function hasCompositePrimaryKey(table, columns) {
    const primaryKeys = tableInfo(table)
      .filter((row) => row.pk > 0)
      .sort((left, right) => left.pk - right.pk)
      .map((row) => row.name);
    return columns.length === primaryKeys.length && columns.every((column, index) => primaryKeys[index] === column);
  }

  function rebuildTable(table, createSql, columns) {
    const legacy = `${table}_legacy_${Date.now()}`;
    database.exec(`ALTER TABLE ${table} RENAME TO ${legacy};`);
    database.exec(`${createSql};`);
    database.exec(
      `INSERT OR IGNORE INTO ${table} (${columns.join(", ")}) SELECT ${columns.join(", ")} FROM ${legacy};`
    );
    database.exec(`DROP TABLE ${legacy};`);
  }

  function applyMigrations() {
    database.exec("BEGIN IMMEDIATE");
    try {
      if (!hasCompositePrimaryKey("field_mappings", ["id", "site_id"])) {
        rebuildTable("field_mappings", createFieldMappingsSql, [
          "id",
          "site_id",
          "wix_field",
          "hubspot_property",
          "direction",
          "transform"
        ]);
      }
      if (!hasCompositePrimaryKey("contact_mappings", ["id", "site_id"])) {
        rebuildTable("contact_mappings", createContactMappingsSql, [
          "id",
          "site_id",
          "wix_contact_id",
          "hubspot_contact_id",
          "last_sync_id",
          "processed_sync_ids",
          "last_wix_updated_at",
          "last_hubspot_updated_at",
          "created_at",
          "updated_at"
        ]);
      }
      if (!hasCompositePrimaryKey("processed_events", ["id", "site_id"])) {
        rebuildTable("processed_events", createProcessedEventsSql, ["id", "site_id", "source", "processed_at"]);
      }
      if (!hasCompositePrimaryKey("webhook_registrations", ["provider", "site_id"])) {
        rebuildTable("webhook_registrations", createWebhookRegistrationsSql, [
          "provider",
          "site_id",
          "status",
          "mode",
          "registered_at",
          "message",
          "data"
        ]);
      }
      if (!hasCompositePrimaryKey("polling_checkpoints", ["provider", "site_id"])) {
        rebuildTable("polling_checkpoints", createPollingCheckpointsSql, [
          "provider",
          "site_id",
          "status",
          "last_poll_started_at",
          "last_poll_completed_at",
          "last_successful_poll_at",
          "last_modified_after",
          "last_seen_modified_at",
          "last_error",
          "updated_at",
          "data"
        ]);
      }
      if (!hasColumn("mock_hubspot_contacts", "site_id")) {
        database.exec("ALTER TABLE mock_hubspot_contacts ADD COLUMN site_id TEXT NOT NULL DEFAULT 'default-site';");
      }
      if (!hasColumn("mock_wix_contacts", "site_id")) {
        database.exec("ALTER TABLE mock_wix_contacts ADD COLUMN site_id TEXT NOT NULL DEFAULT 'default-site';");
      }
      database.exec("CREATE INDEX IF NOT EXISTS idx_sync_events_site_created ON sync_events (site_id, created_at DESC);");
      database.exec("CREATE INDEX IF NOT EXISTS idx_retry_jobs_site_status_due ON retry_jobs (site_id, status, next_attempt_at);");
      database.exec("CREATE INDEX IF NOT EXISTS idx_hubspot_connections_portal ON hubspot_connections (portal_id);");
      database.exec(`PRAGMA user_version = ${SCHEMA_VERSION};`);
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  }

  applyMigrations();

  function tableEmpty(name, siteId = "default-site") {
    return database.prepare(`SELECT COUNT(*) AS count FROM ${name} WHERE site_id = ?`).get(siteId).count === 0;
  }

  function seed(siteId = "default-site") {
    if (!tableEmpty("field_mappings", siteId)) return;
    const db = initialDb();
    db.connection = {
      ...db.connection,
      siteId,
      installId: db.connection.installId
    };
    write(db);
  }

  function all(statement, ...params) {
    return database.prepare(statement).all(...params);
  }

  function read(siteId = "default-site") {
    seed(siteId);
    const connectionRow = database
      .prepare("SELECT * FROM hubspot_connections WHERE id = ?")
      .get(siteId);
    const connection = prepareDbFromStorage({
      connection: connectionRow
      ? parse(connectionRow.data, {})
      : { ...initialDb().connection, siteId }
    }, env).connection;

    return {
      connection,
      installations: all("SELECT data FROM installations WHERE site_id = ?", siteId).map((row) => parse(row.data, {})),
      mappings: all("SELECT * FROM field_mappings WHERE site_id = ? ORDER BY rowid", siteId).map((row) => ({
        id: publicId(siteId, row.id),
        wixField: row.wix_field,
        hubspotProperty: row.hubspot_property,
        direction: row.direction,
        transform: row.transform
      })),
      contactMappings: all("SELECT * FROM contact_mappings WHERE site_id = ? ORDER BY rowid", siteId).map((row) => ({
        id: row.id,
        wixContactId: row.wix_contact_id,
        hubspotContactId: row.hubspot_contact_id,
        lastSyncId: row.last_sync_id,
        processedSyncIds: parse(row.processed_sync_ids, []),
        lastWixUpdatedAt: row.last_wix_updated_at,
        lastHubSpotUpdatedAt: row.last_hubspot_updated_at,
        createdAt: row.created_at,
        updatedAt: row.updated_at
      })),
      processedEvents: all("SELECT * FROM processed_events WHERE site_id = ? ORDER BY processed_at DESC", siteId).map((row) => ({
        id: row.id,
        source: row.source,
        processedAt: row.processed_at
      })),
      syncEvents: all("SELECT * FROM sync_events WHERE site_id = ? ORDER BY created_at DESC LIMIT 100", siteId).map((row) => ({
        id: row.id,
        createdAt: row.created_at,
        source: row.source,
        syncId: row.sync_id,
        status: row.status,
        message: row.message,
        details: parse(row.details, {})
      })),
      formSubmissions: all("SELECT data FROM form_submissions WHERE site_id = ? ORDER BY created_at DESC LIMIT 50", siteId).map((row) =>
        parse(row.data, {})
      ),
      oauthStates: all("SELECT * FROM oauth_states").map((row) => ({
        state: row.state,
        siteId: row.site_id,
        installId: row.install_id,
        redirectTo: row.redirect_to,
        createdAt: row.created_at,
        consumedAt: row.consumed_at
      })),
      webhookRegistrations: all("SELECT data FROM webhook_registrations WHERE site_id = ?", siteId).map((row) => parse(row.data, {})),
      pollingCheckpoints: all("SELECT data FROM polling_checkpoints WHERE site_id = ?", siteId).map((row) => parse(row.data, {})),
      retryJobs: all("SELECT * FROM retry_jobs WHERE site_id = ? ORDER BY created_at DESC", siteId).map((row) => ({
        id: row.id,
        direction: row.direction,
        syncId: row.sync_id,
        status: row.status,
        attempts: row.attempts,
        nextAttemptAt: row.next_attempt_at,
        lastError: row.last_error,
        permanent: Boolean(row.permanent),
        payload: parse(row.payload, {}),
        createdAt: row.created_at,
        updatedAt: row.updated_at
      })),
      mockHubSpotContacts: all("SELECT data FROM mock_hubspot_contacts WHERE site_id = ?", siteId).map((row) => parse(row.data, {})),
      mockWixContacts: all("SELECT data FROM mock_wix_contacts WHERE site_id = ?", siteId).map((row) => parse(row.data, {}))
    };
  }

  function readByPortalId(portalId) {
    if (!portalId) return read();
    const row = database
      .prepare("SELECT site_id FROM hubspot_connections WHERE portal_id = ? LIMIT 1")
      .get(String(portalId));
    return read(row?.site_id || "default-site");
  }

  function write(db) {
    try {
      database.exec("BEGIN IMMEDIATE");
      const state = prepareDbForStorage(db, env);
      const siteId = state.connection?.siteId || "default-site";
      database.prepare("DELETE FROM installations WHERE site_id = ?").run(siteId);
      database.prepare("DELETE FROM hubspot_connections WHERE id = ?").run(siteId);
      database.prepare("DELETE FROM field_mappings WHERE site_id = ?").run(siteId);
      database.prepare("DELETE FROM contact_mappings WHERE site_id = ?").run(siteId);
      database.prepare("DELETE FROM processed_events WHERE site_id = ?").run(siteId);
      database.prepare("DELETE FROM sync_events WHERE site_id = ?").run(siteId);
      database.prepare("DELETE FROM form_submissions WHERE site_id = ?").run(siteId);
      database.prepare("DELETE FROM oauth_states").run();
      database.prepare("DELETE FROM webhook_registrations WHERE site_id = ?").run(siteId);
      database.prepare("DELETE FROM polling_checkpoints WHERE site_id = ?").run(siteId);
      database.prepare("DELETE FROM retry_jobs WHERE site_id = ?").run(siteId);
      database.prepare("DELETE FROM mock_hubspot_contacts WHERE site_id = ?").run(siteId);
      database.prepare("DELETE FROM mock_wix_contacts WHERE site_id = ?").run(siteId);
      database
        .prepare(
          "INSERT INTO hubspot_connections (id, site_id, connected, portal_id, data) VALUES (?, ?, ?, ?, ?)"
        )
        .run(siteId, siteId, state.connection?.connected ? 1 : 0, state.connection?.portalId || null, json(state.connection, {}));

      for (const installation of state.installations || []) {
        database
          .prepare("INSERT INTO installations (id, site_id, data) VALUES (?, ?, ?)")
          .run(installation.id || installation.installId || "default-installation", installation.siteId || siteId, json(installation, {}));
      }

      for (const mapping of state.mappings || []) {
        database
          .prepare(
            "INSERT INTO field_mappings (id, site_id, wix_field, hubspot_property, direction, transform) VALUES (?, ?, ?, ?, ?, ?)"
          )
          .run(siteScopedId(siteId, mapping.id), siteId, mapping.wixField, mapping.hubspotProperty, mapping.direction, mapping.transform);
      }

      for (const mapping of state.contactMappings || []) {
        database
          .prepare(
            `INSERT INTO contact_mappings
             (id, site_id, wix_contact_id, hubspot_contact_id, last_sync_id, processed_sync_ids, last_wix_updated_at, last_hubspot_updated_at, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .run(
            mapping.id,
            siteId,
            mapping.wixContactId || null,
            mapping.hubspotContactId || null,
            mapping.lastSyncId || null,
            json(mapping.processedSyncIds, []),
            mapping.lastWixUpdatedAt || null,
            mapping.lastHubSpotUpdatedAt || null,
            mapping.createdAt || null,
            mapping.updatedAt || null
          );
      }

      const processedEventRows = new Map();
      for (const event of state.processedEvents || []) {
        processedEventRows.set(event.id, event);
      }
      for (const mapping of state.contactMappings || []) {
        for (const syncId of mapping.processedSyncIds || []) {
          processedEventRows.set(syncId, {
            id: syncId,
            source: "sync",
            processedAt: mapping.updatedAt || new Date().toISOString()
          });
        }
      }
      for (const event of processedEventRows.values()) {
        database
          .prepare("INSERT INTO processed_events (id, site_id, source, processed_at) VALUES (?, ?, ?, ?)")
          .run(event.id, siteId, event.source || "unknown", event.processedAt || new Date().toISOString());
      }

      for (const event of state.syncEvents || []) {
        database
          .prepare(
            "INSERT INTO sync_events (id, site_id, created_at, source, sync_id, status, message, details) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
          )
          .run(
            event.id,
            siteId,
            event.createdAt,
            event.source || null,
            event.syncId || null,
            event.status || null,
            event.message || null,
            json(event.details, {})
          );
      }

      for (const submission of state.formSubmissions || []) {
        database
          .prepare("INSERT INTO form_submissions (id, site_id, created_at, form_id, data) VALUES (?, ?, ?, ?, ?)")
          .run(submission.id, siteId, submission.createdAt, submission.formId || null, json(submission, {}));
      }

      for (const item of state.oauthStates || []) {
        database
          .prepare(
            "INSERT INTO oauth_states (state, site_id, install_id, redirect_to, created_at, consumed_at) VALUES (?, ?, ?, ?, ?, ?)"
          )
          .run(item.state, item.siteId || siteId, item.installId || null, item.redirectTo || "/", item.createdAt, item.consumedAt || null);
      }

      for (const registration of state.webhookRegistrations || []) {
        database
          .prepare(
            "INSERT INTO webhook_registrations (provider, site_id, status, mode, registered_at, message, data) VALUES (?, ?, ?, ?, ?, ?, ?)"
          )
          .run(
            registration.provider,
            registration.siteId || siteId,
            registration.status || "unknown",
            registration.mode || null,
            registration.registeredAt || null,
            registration.message || null,
            json(registration, {})
          );
      }

      for (const checkpoint of state.pollingCheckpoints || []) {
        database
          .prepare(
            `INSERT INTO polling_checkpoints
             (provider, site_id, status, last_poll_started_at, last_poll_completed_at, last_successful_poll_at, last_modified_after, last_seen_modified_at, last_error, updated_at, data)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .run(
            checkpoint.provider,
            checkpoint.siteId || siteId,
            checkpoint.status || "idle",
            checkpoint.lastPollStartedAt || null,
            checkpoint.lastPollCompletedAt || null,
            checkpoint.lastSuccessfulPollAt || null,
            checkpoint.lastModifiedAfter || null,
            checkpoint.lastSeenModifiedAt || null,
            checkpoint.lastError || null,
            checkpoint.updatedAt || new Date().toISOString(),
            json(checkpoint, {})
          );
      }

      for (const job of state.retryJobs || []) {
        database
          .prepare(
            `INSERT INTO retry_jobs
             (id, site_id, direction, sync_id, status, attempts, next_attempt_at, last_error, permanent, payload, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .run(
            job.id,
            siteId,
            job.direction,
            job.syncId || null,
            job.status || "pending",
            job.attempts || 0,
            job.nextAttemptAt || null,
            job.lastError || null,
            job.permanent ? 1 : 0,
            json(job.payload, {}),
            job.createdAt,
            job.updatedAt
          );
      }

      for (const contact of state.mockHubSpotContacts || []) {
        database
          .prepare("INSERT INTO mock_hubspot_contacts (id, site_id, data) VALUES (?, ?, ?)")
          .run(siteScopedId(siteId, contact.id), siteId, json({ ...contact, siteId }, {}));
      }
      for (const contact of state.mockWixContacts || []) {
        database
          .prepare("INSERT INTO mock_wix_contacts (id, site_id, data) VALUES (?, ?, ?)")
          .run(siteScopedId(siteId, contact.id), siteId, json({ ...contact, siteId }, {}));
      }
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  }

  return { read, readByPortalId, write };
}
