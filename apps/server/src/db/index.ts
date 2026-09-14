import { migrateLocalTime } from './local-time.js';
import { formatSystemTime } from '../time.js';
import { DatabaseSync } from 'node:sqlite';
import { existsSync, lstatSync, mkdirSync, realpathSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

/** 按版本排序的数据迁移集合。 */
const migrations = [
  `CREATE TABLE users (id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL, created_at TEXT NOT NULL);
   CREATE TABLE sessions (token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, expires_at TEXT NOT NULL);
   CREATE INDEX sessions_expiry ON sessions(expires_at);
   CREATE TABLE login_attempts (ip TEXT NOT NULL, created_at TEXT NOT NULL);
   CREATE INDEX login_attempts_time ON login_attempts(created_at);
   CREATE TABLE conversations (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), title TEXT NOT NULL, created_at TEXT NOT NULL);
   CREATE TABLE messages (id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE, role TEXT NOT NULL, content TEXT NOT NULL, created_at TEXT NOT NULL);
   CREATE INDEX messages_conversation ON messages(conversation_id, created_at);
   CREATE TABLE model_configs (user_id TEXT PRIMARY KEY REFERENCES users(id), base_url TEXT NOT NULL, model TEXT NOT NULL, api_key TEXT NOT NULL, updated_at TEXT NOT NULL);
   CREATE TABLE tasks (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE, status TEXT NOT NULL, idempotency_key TEXT NOT NULL, input TEXT NOT NULL, error TEXT, usage TEXT, created_at TEXT NOT NULL, finished_at TEXT, UNIQUE(user_id, idempotency_key));
   CREATE INDEX tasks_conversation ON tasks(conversation_id, created_at);
   CREATE TABLE task_events (task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE, seq INTEGER NOT NULL, type TEXT NOT NULL, data TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(task_id, seq));
   CREATE TABLE tool_calls (id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE, name TEXT NOT NULL, arguments TEXT NOT NULL, status TEXT NOT NULL, result TEXT, created_at TEXT NOT NULL, finished_at TEXT);
   CREATE TABLE memories (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), content TEXT NOT NULL, priority INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);`,
  `ALTER TABLE tool_calls ADD COLUMN arguments_digest TEXT;
   ALTER TABLE tool_calls ADD COLUMN snapshot TEXT;
   ALTER TABLE tool_calls ADD COLUMN decision TEXT;
   ALTER TABLE tool_calls ADD COLUMN decided_at TEXT;
   CREATE INDEX tool_calls_task ON tool_calls(task_id);`,
  `CREATE TABLE assistant_config_revisions (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), version INTEGER NOT NULL, snapshot TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(user_id,version));
   CREATE TABLE assistant_configs (user_id TEXT PRIMARY KEY REFERENCES users(id), revision_id TEXT NOT NULL REFERENCES assistant_config_revisions(id));
   ALTER TABLE tasks ADD COLUMN assistant_config_revision_id TEXT REFERENCES assistant_config_revisions(id);`,
  `CREATE TABLE conversation_rules (conversation_id TEXT PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE, content TEXT NOT NULL, version INTEGER NOT NULL, updated_at TEXT NOT NULL);
   ALTER TABLE tasks ADD COLUMN conversation_rules_snapshot TEXT;`,
  `CREATE TABLE assistant_settings_current (user_id TEXT PRIMARY KEY REFERENCES users(id), config TEXT NOT NULL, version INTEGER NOT NULL, updated_at TEXT NOT NULL);
   INSERT INTO assistant_settings_current SELECT c.user_id,r.snapshot,r.version,r.created_at FROM assistant_configs c JOIN assistant_config_revisions r ON r.id=c.revision_id;
   ALTER TABLE tasks ADD COLUMN assistant_config_snapshot TEXT;
   UPDATE tasks SET assistant_config_snapshot=(SELECT json_object('config',json(r.snapshot),'version',r.version) FROM assistant_config_revisions r WHERE r.id=tasks.assistant_config_revision_id) WHERE assistant_config_revision_id IS NOT NULL;
   ALTER TABLE tasks DROP COLUMN assistant_config_revision_id;
   DROP TABLE assistant_configs;
   DROP TABLE assistant_config_revisions;
   ALTER TABLE assistant_settings_current RENAME TO assistant_configs;`,
  `CREATE TABLE model_providers (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), name TEXT NOT NULL, base_url TEXT NOT NULL, api_key TEXT NOT NULL, models TEXT NOT NULL, updated_at TEXT NOT NULL);
   CREATE INDEX model_providers_user ON model_providers(user_id);
   CREATE TABLE model_defaults (user_id TEXT PRIMARY KEY REFERENCES users(id), provider_id TEXT NOT NULL REFERENCES model_providers(id), model TEXT NOT NULL);
   INSERT INTO model_providers SELECT 'legacy-' || user_id,user_id,'原有提供商',base_url,api_key,json_array(model),updated_at FROM model_configs;
   INSERT INTO model_defaults SELECT user_id,'legacy-' || user_id,model FROM model_configs;
   DROP TABLE model_configs;
   ALTER TABLE tasks ADD COLUMN model_snapshot TEXT;`,
  `CREATE TABLE channel_accounts (
     id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), kind TEXT NOT NULL CHECK(kind IN ('qq','weixin')),
     remote_id TEXT NOT NULL, secret TEXT NOT NULL, base_url TEXT NOT NULL DEFAULT '', enabled INTEGER NOT NULL DEFAULT 0,
     cursor TEXT NOT NULL DEFAULT '', paired_sender TEXT, pairing_hash TEXT, pairing_expires_at TEXT,
     created_at TEXT NOT NULL, UNIQUE(user_id,kind));
   CREATE TABLE channel_conversations (
     account_id TEXT NOT NULL REFERENCES channel_accounts(id) ON DELETE CASCADE, sender_id TEXT NOT NULL,
     conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE, PRIMARY KEY(account_id,sender_id));
   CREATE TABLE channel_inbox (
     id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES channel_accounts(id) ON DELETE CASCADE,
     event_id TEXT NOT NULL, sender_id TEXT NOT NULL, text TEXT NOT NULL, reply_context TEXT NOT NULL,
     task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL, status TEXT NOT NULL, approval_notified INTEGER NOT NULL DEFAULT 0,
     created_at TEXT NOT NULL, UNIQUE(account_id,event_id));
   CREATE INDEX channel_inbox_active ON channel_inbox(status);
   CREATE TABLE channel_outbox (
     id TEXT PRIMARY KEY, inbox_id TEXT NOT NULL REFERENCES channel_inbox(id) ON DELETE CASCADE,
     part INTEGER NOT NULL, text TEXT NOT NULL, status TEXT NOT NULL, error TEXT,
     created_at TEXT NOT NULL, UNIQUE(inbox_id,part));
   CREATE INDEX channel_outbox_status ON channel_outbox(status);`,
  `ALTER TABLE tasks ADD COLUMN tool_policy TEXT NOT NULL DEFAULT 'full' CHECK(tool_policy IN ('full','readonly'));
   CREATE TABLE schedules (
     id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), name TEXT NOT NULL,
     kind TEXT NOT NULL CHECK(kind IN ('reminder','agent')), content TEXT NOT NULL, cron TEXT NOT NULL,
     enabled INTEGER NOT NULL, version INTEGER NOT NULL, next_run_at TEXT, timezone TEXT NOT NULL,
     created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT);
   CREATE INDEX schedules_due ON schedules(enabled,next_run_at);
   CREATE TABLE schedule_occurrences (
     id TEXT PRIMARY KEY, schedule_id TEXT NOT NULL REFERENCES schedules(id), user_id TEXT NOT NULL REFERENCES users(id),
     trigger_key TEXT NOT NULL, source TEXT NOT NULL CHECK(source IN ('cron','manual')), scheduled_at TEXT NOT NULL,
     snapshot TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('pending','running','succeeded','failed','skipped','cancelled','interrupted')),
     task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL, conversation_id TEXT REFERENCES conversations(id) ON DELETE SET NULL,
     reason TEXT, created_at TEXT NOT NULL, started_at TEXT, finished_at TEXT, read_at TEXT,
     UNIQUE(schedule_id,trigger_key));
   CREATE INDEX schedule_occurrences_active ON schedule_occurrences(status,scheduled_at);
   CREATE INDEX schedule_occurrences_task ON schedule_occurrences(task_id);
   CREATE INDEX schedule_occurrences_user ON schedule_occurrences(user_id,created_at);`,
  migrateLocalTime,
  `CREATE TABLE web_settings (
     user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
     provider TEXT NOT NULL CHECK(provider='tavily'), enabled INTEGER NOT NULL DEFAULT 0,
     allow_fetch INTEGER NOT NULL DEFAULT 1, allow_schedules INTEGER NOT NULL DEFAULT 0,
     api_key TEXT NOT NULL DEFAULT '', version INTEGER NOT NULL, updated_at TEXT NOT NULL);
   ALTER TABLE tasks ADD COLUMN web_snapshot TEXT;`,
  `ALTER TABLE tasks ADD COLUMN kind TEXT NOT NULL DEFAULT 'chat' CHECK(kind IN ('chat','summary'));
   ALTER TABLE tasks ADD COLUMN context_snapshot TEXT;
   CREATE TABLE conversation_context (
     conversation_id TEXT PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
     auto_summary INTEGER NOT NULL DEFAULT 0, version INTEGER NOT NULL DEFAULT 0,
     summary TEXT NOT NULL DEFAULT '', valid INTEGER NOT NULL DEFAULT 0,
     through_cursor INTEGER NOT NULL DEFAULT 0, through_message_id TEXT,
     covered_messages INTEGER NOT NULL DEFAULT 0, source_truncated INTEGER NOT NULL DEFAULT 0,
     model TEXT, updated_at TEXT);
   CREATE TRIGGER summary_message_update AFTER UPDATE OF content,role,id ON messages
     WHEN OLD.content<>NEW.content OR OLD.role<>NEW.role OR OLD.id<>NEW.id BEGIN
       UPDATE conversation_context SET valid=0,version=version+1
       WHERE conversation_id=OLD.conversation_id AND OLD.rowid<=through_cursor;
     END;
   CREATE TRIGGER summary_message_delete AFTER DELETE ON messages BEGIN
     UPDATE conversation_context SET valid=0,version=version+1
     WHERE conversation_id=OLD.conversation_id AND OLD.rowid<=through_cursor;
   END;
   CREATE INDEX tasks_user_history ON tasks(user_id,conversation_id,created_at);`,
  `CREATE TABLE task_skills (
     task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE, snapshot TEXT NOT NULL);
   CREATE TABLE task_skill_loads (
     id INTEGER PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
     skill_id TEXT NOT NULL, name TEXT NOT NULL, version TEXT NOT NULL,
     resource TEXT, loaded_at TEXT NOT NULL);`,
  `ALTER TABLE channel_accounts ADD COLUMN binding_version INTEGER NOT NULL DEFAULT 0;
   ALTER TABLE schedules ADD COLUMN delivery_target TEXT;
   ALTER TABLE schedule_occurrences ADD COLUMN delivery_target TEXT;
   CREATE TABLE schedule_deliveries (
     occurrence_id TEXT PRIMARY KEY REFERENCES schedule_occurrences(id) ON DELETE CASCADE,
     account_id TEXT NOT NULL, kind TEXT NOT NULL, text TEXT NOT NULL,
     status TEXT NOT NULL CHECK(status IN ('pending','sending','sent','failed','unknown','cancelled')),
     error TEXT, created_at TEXT NOT NULL);
   CREATE INDEX schedule_deliveries_pending ON schedule_deliveries(status);`,
  `CREATE TABLE system_log_settings (
     user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
     retention_days INTEGER NOT NULL DEFAULT 7 CHECK(retention_days BETWEEN 1 AND 30),
     version INTEGER NOT NULL DEFAULT 1, updated_at TEXT NOT NULL);
   CREATE TABLE system_logs (
     id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     level TEXT NOT NULL CHECK(level IN ('info','warning','error')), source TEXT NOT NULL,
     event TEXT NOT NULL, message TEXT NOT NULL, entity_type TEXT, entity_id TEXT,
     metadata TEXT, created_at TEXT NOT NULL);
   CREATE INDEX system_logs_user_id ON system_logs(user_id,id DESC);
   CREATE INDEX system_logs_user_time ON system_logs(user_id,created_at);`,
  (db: DatabaseSync) => {
    // 旧版本回归测试可能保留已经升级过的表；列存在时迁移已完成。
    if (db.prepare("SELECT 1 FROM pragma_table_info('web_settings') WHERE name='base_url'").get())
      return;
    db.exec(`CREATE TABLE web_settings_new (
       user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
       provider TEXT NOT NULL CHECK(provider IN ('tavily','firecrawl','exa','brave','searxng')),
       enabled INTEGER NOT NULL DEFAULT 0, allow_fetch INTEGER NOT NULL DEFAULT 1,
       allow_schedules INTEGER NOT NULL DEFAULT 0, api_key TEXT NOT NULL DEFAULT '',
       base_url TEXT NOT NULL DEFAULT '', version INTEGER NOT NULL, updated_at TEXT NOT NULL);
     INSERT INTO web_settings_new
       (user_id,provider,enabled,allow_fetch,allow_schedules,api_key,base_url,version,updated_at)
       SELECT user_id,provider,enabled,allow_fetch,allow_schedules,api_key,'',version,updated_at FROM web_settings;
     DROP TABLE web_settings;
     ALTER TABLE web_settings_new RENAME TO web_settings;`);
  },
  `ALTER TABLE system_log_settings ADD COLUMN log_level TEXT NOT NULL DEFAULT 'info' CHECK(log_level IN ('info','warn','error'));`,
  `ALTER TABLE model_providers ADD COLUMN preset_id TEXT NOT NULL DEFAULT 'custom';`,
  (db: DatabaseSync) => {
    db.exec(`PRAGMA defer_foreign_keys=ON;
   CREATE TABLE schedules_new (
     id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), name TEXT NOT NULL,
     kind TEXT NOT NULL CHECK(kind IN ('reminder','agent','command')), content TEXT NOT NULL, cron TEXT NOT NULL,
     enabled INTEGER NOT NULL, version INTEGER NOT NULL, next_run_at TEXT, timezone TEXT NOT NULL,
     created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT, delivery_target TEXT,
     command_spec TEXT);
   INSERT INTO schedules_new SELECT *,NULL FROM schedules;
   DROP TABLE schedules;
   ALTER TABLE schedules_new RENAME TO schedules;
   CREATE INDEX schedules_due ON schedules(enabled,next_run_at);
   UPDATE schedules SET enabled=0,next_run_at=NULL,version=version+1 WHERE kind='reminder';
   UPDATE schedule_occurrences SET status='cancelled',reason='固定提醒已停用',finished_at=created_at
     WHERE status='pending' AND json_extract(snapshot,'$.kind')='reminder';
   ALTER TABLE schedule_occurrences ADD COLUMN command_result TEXT;
   CREATE TABLE schedule_executor_settings (id INTEGER PRIMARY KEY CHECK(id=1), url TEXT NOT NULL,
     token TEXT NOT NULL, version INTEGER NOT NULL);`);
    // 重建父表后先验证真实引用，再清除 DROP TABLE 留下的延迟约束计数。
    if (db.prepare('PRAGMA foreign_key_check').all().length)
      throw new Error('定时任务迁移外键校验失败');
    db.exec('PRAGMA defer_foreign_keys=OFF;');
  },
  (db: DatabaseSync) => {
    // 保留 ON DELETE CASCADE 子表，重建旧 CHECK 约束后按依赖顺序恢复。
    db.exec(`CREATE TEMP TABLE webhook_conversations AS SELECT * FROM channel_conversations;
      CREATE TEMP TABLE webhook_inbox AS SELECT * FROM channel_inbox;
      CREATE TEMP TABLE webhook_outbox AS SELECT * FROM channel_outbox;
      CREATE TABLE channel_accounts_new (
        id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id),
        kind TEXT NOT NULL CHECK(kind IN ('qq','weixin','webhook')),
        remote_id TEXT NOT NULL, secret TEXT NOT NULL, base_url TEXT NOT NULL DEFAULT '',
        enabled INTEGER NOT NULL DEFAULT 0, cursor TEXT NOT NULL DEFAULT '', paired_sender TEXT,
        pairing_hash TEXT, pairing_expires_at TEXT, created_at TEXT NOT NULL,
        binding_version INTEGER NOT NULL DEFAULT 0, UNIQUE(user_id,kind));
      INSERT INTO channel_accounts_new SELECT * FROM channel_accounts;
      DROP TABLE channel_accounts;
      ALTER TABLE channel_accounts_new RENAME TO channel_accounts;
      INSERT INTO channel_conversations SELECT * FROM webhook_conversations;
      INSERT INTO channel_inbox SELECT * FROM webhook_inbox;
      INSERT INTO channel_outbox SELECT * FROM webhook_outbox;
      DROP TABLE webhook_conversations;
      DROP TABLE webhook_inbox;
      DROP TABLE webhook_outbox;`);
    if (db.prepare('PRAGMA foreign_key_check').all().length)
      throw new Error('Webhook 渠道迁移外键校验失败');
  },
  // 权限简化：保留计划、启停状态及历史，只移除旧连接和脚本授权信息。
  `UPDATE schedules SET command_spec=json_object('command',content,
      'cwd',COALESCE(json_extract(command_spec,'$.cwd'),'.'),
      'timeoutMs',COALESCE(json_extract(command_spec,'$.timeoutMs'),60000))
    WHERE kind='command';
   DROP TABLE IF EXISTS schedule_executor_settings;`,
  // 旧 Webhook 按默认 POST JSON 和原 Bearer Token 读取，保留启用和投递代次。
  `ALTER TABLE channel_accounts ADD COLUMN webhook_config TEXT;`,
  // 压缩检查点保留用户原文和当前流式消息边界。
  (db: DatabaseSync) => {
    if (
      !db
        .prepare('PRAGMA table_info(conversation_context)')
        .all()
        .some((row) => row.name === 'checkpoint')
    )
      db.exec('ALTER TABLE conversation_context ADD COLUMN checkpoint TEXT');
  },
  // 网站图标随数据库持久化，不放入可由聊天工具修改的工作区。
  `CREATE TABLE IF NOT EXISTS site_icons (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  image BLOB NOT NULL, version TEXT NOT NULL, updated_at TEXT NOT NULL
);`,
  // 助手头像独立保存，升级不会改变已有网站图标或身份配置。
  `CREATE TABLE IF NOT EXISTS assistant_avatars (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  image BLOB NOT NULL, version TEXT NOT NULL, updated_at TEXT NOT NULL
);`,
  (db: DatabaseSync) => {
    // 重建渠道类型约束时保留级联子表及原有凭据、游标和去重记录。
    if (
      db
        .prepare("SELECT 1 FROM pragma_table_info('channel_accounts') WHERE name='email_config'")
        .get()
    )
      return;
    db.exec(`CREATE TEMP TABLE email_conversations AS SELECT * FROM channel_conversations;
      CREATE TEMP TABLE email_inbox AS SELECT * FROM channel_inbox;
      CREATE TEMP TABLE email_outbox AS SELECT * FROM channel_outbox;
      CREATE TABLE channel_accounts_new (
        id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id),
        kind TEXT NOT NULL CHECK(kind IN ('qq','weixin','webhook','email')),
        remote_id TEXT NOT NULL, secret TEXT NOT NULL, base_url TEXT NOT NULL DEFAULT '',
        enabled INTEGER NOT NULL DEFAULT 0, cursor TEXT NOT NULL DEFAULT '', paired_sender TEXT,
        pairing_hash TEXT, pairing_expires_at TEXT, created_at TEXT NOT NULL,
        binding_version INTEGER NOT NULL DEFAULT 0, webhook_config TEXT, email_config TEXT,
        UNIQUE(user_id,kind));
      INSERT INTO channel_accounts_new SELECT *,NULL FROM channel_accounts;
      DROP TABLE channel_accounts;
      ALTER TABLE channel_accounts_new RENAME TO channel_accounts;
      INSERT INTO channel_conversations SELECT * FROM email_conversations;
      INSERT INTO channel_inbox SELECT * FROM email_inbox;
      INSERT INTO channel_outbox SELECT * FROM email_outbox;
      DROP TABLE email_conversations;
      DROP TABLE email_inbox;
      DROP TABLE email_outbox;`);
    if (db.prepare('PRAGMA foreign_key_check').all().length)
      throw new Error('邮箱渠道迁移外键校验失败');
  },
  `CREATE TABLE IF NOT EXISTS site_settings (user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, name TEXT NOT NULL);`,
];

class LockedDatabase extends DatabaseSync {
  constructor(
    path: string,
    private lease?: DatabaseSync,
  ) {
    super(path);
  }
  /** 关闭当前资源或编辑界面。 */
  override close() {
    try {
      super.close();
    } finally {
      this.lease?.close();
      this.lease = undefined;
    }
  }
}

/** 打开 SQLite 数据库并执行待应用迁移。 */
export const openDatabase = (path: string): DatabaseSync => {
  if (path !== ':memory:') {
    mkdirSync(dirname(path), { recursive: true });
    path = existsSync(path)
      ? realpathSync(path)
      : join(realpathSync(dirname(path)), basename(path));
    if (existsSync(path) && lstatSync(path).nlink > 1) throw new Error('数据库不能使用硬链接别名');
  }
  // 独立 SQLite 独占事务作为进程租约；崩溃由操作系统释放，不依赖 PID 文件清理。
  let lease: DatabaseSync | undefined;
  if (path !== ':memory:') {
    lease = new DatabaseSync(`${path}.lock`);
    try {
      lease.exec(
        'PRAGMA busy_timeout=0; BEGIN EXCLUSIVE; CREATE TABLE IF NOT EXISTS instance_lock (id INTEGER);',
      );
    } catch {
      lease.close();
      throw new Error('该数据库已有 MlClaw 实例运行，拒绝重复启动');
    }
  }
  /** 当前数据库连接。 */
  let db: LockedDatabase;
  try {
    db = new LockedDatabase(path, lease);
  } catch (/* 本次捕获的异常，用于错误反馈或清理。 */ error) {
    lease?.close();
    throw error;
  }
  try {
    db.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;');
    db.exec(
      'CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)',
    );
    transaction(db, () => {
      /** schema_migrations 表的查询记录。 */
      const current = Number(
        db.prepare('SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations').get()!
          .version,
      );
      if (current > migrations.length) throw new Error('数据库版本高于当前程序，禁止降级启动');
      for (/* 逐项处理循环索引。 */ let i = current; i < migrations.length; i++) {
        /** 当前待执行的数据迁移。 */
        const migration = migrations[i]!;
        if (typeof migration === 'string') db.exec(migration);
        else migration(db);
        db.prepare('INSERT INTO schema_migrations VALUES (?, ?)').run(i + 1, formatSystemTime());
      }
    });
    return db;
  } catch (/* 本次捕获的异常，用于错误反馈或清理。 */ error) {
    db.close();
    throw error;
  }
};
/** 在事务中执行写入，失败时回滚。 */
export const transaction = <T>(db: DatabaseSync, run: () => T): T => {
  db.exec('BEGIN IMMEDIATE');
  try {
    /** 本次处理结果。 */
    const result = run();
    db.exec('COMMIT');
    return result;
  } catch (/* 本次捕获的异常，用于错误反馈或清理。 */ error) {
    db.exec('ROLLBACK');
    throw error;
  }
};
