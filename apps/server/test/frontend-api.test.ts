import { test } from "node:test";
import assert from "node:assert/strict";
import { fixture, waitFor } from "./helpers.js";
import type { ModelEvent, Provider } from "../src/providers/types.js";

test("会话和任务分页搜索有界、游标无重叠、归属隔离及非法筛选校验", async () => {
  const f = await fixture();
  try {
    const owner = f.db
      .prepare("SELECT user_id FROM conversations WHERE id=?")
      .get(f.conversationId)!.user_id;
    for (let i = 0; i < 105; i++) {
      f.db
        .prepare(
          "INSERT INTO conversations (id,user_id,title,created_at) VALUES (?,?,?,?)",
        )
        .run(`page-${i}`, owner, `分页会话 ${i}`, "2026-09-09 13:00:00");
      f.db
        .prepare(
          "INSERT INTO tasks (id,user_id,conversation_id,status,idempotency_key,input,created_at) VALUES (?,?,?,?,?,?,?)",
        )
        .run(
          `page-task-${i}`,
          owner,
          `page-${i}`,
          "succeeded",
          `page-key-${i}`,
          `分页任务 ${i}`,
          "2026-09-09 13:00:00",
        );
    }
    for (const kind of ["conversations", "tasks"]) {
      const url = `/api/${kind}/page`;
      assert.equal((await f.app.inject(url)).statusCode, 401);
      const first = (await f.app.inject({ url, headers: f.headers })).json();
      const second = (
        await f.app.inject({
          url: `${url}?before=${first.nextCursor}`,
          headers: f.headers,
        })
      ).json();
      assert.equal(first.items.length, 50);
      assert.equal(second.items.length, 50);
      assert.equal(
        new Set([...first.items, ...second.items].map((item) => item.id)).size,
        100,
      );
      assert.ok(!JSON.stringify(first).includes("idempotency_key"));
      assert.equal(
        (await f.app.inject({ url: `${url}?before=-1`, headers: f.headers }))
          .statusCode,
        400,
      );
      assert.equal(
        (
          await f.app.inject({
            url: `${url}?q=${encodeURIComponent("105不存在")}`,
            headers: f.headers,
          })
        ).json().items.length,
        0,
      );
    }
    assert.equal(
      (
        await f.app.inject({
          url: "/api/tasks/page?status=unknown",
          headers: f.headers,
        })
      ).statusCode,
      400,
    );
    assert.equal(
      (
        await f.app.inject({
          url: "/api/tasks/page?conversationId=absent",
          headers: f.headers,
        })
      ).statusCode,
      404,
    );
    const match = (
      await f.app.inject({
        url: `/api/conversations/page?q=${encodeURIComponent("分页会话 104")}`,
        headers: f.headers,
      })
    ).json();
    assert.equal(match.items.length, 1);
    f.db
      .prepare("INSERT INTO users VALUES (?,?,?,?)")
      .run("page-other", "page-other", "hash", "now");
    f.db
      .prepare("UPDATE conversations SET user_id=? WHERE id=?")
      .run("page-other", "page-104");
    f.db
      .prepare("UPDATE tasks SET user_id=? WHERE id=?")
      .run("page-other", "page-task-104");
    assert.equal(
      (
        await f.app.inject({
          url: `/api/conversations/page?q=${encodeURIComponent("分页会话 104")}`,
          headers: f.headers,
        })
      ).json().items.length,
      0,
    );
    assert.equal(
      (
        await f.app.inject({
          url: "/api/tasks/page?conversationId=page-104",
          headers: f.headers,
        })
      ).statusCode,
      404,
    );
    assert.equal((await f.app.inject("/api/reminders/unread")).statusCode, 401);
    assert.equal(
      (
        await f.app.inject({ url: "/api/reminders/unread", headers: f.headers })
      ).json().unread,
      0,
    );
  } finally {
    await f.app.close();
  }
});

test("全局运行状态需要认证、只返回本人任务摘要，取消后清空", async () => {
  let release: (() => void) | undefined;
  const provider: Provider = {
    async *stream(): AsyncGenerator<ModelEvent> {
      yield { type: "delta", text: "开始" };
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      yield { type: "complete", calls: [] };
    },
  };
  const f = await fixture(provider);
  try {
    assert.equal((await f.app.inject("/api/runtime-status")).statusCode, 401);
    assert.equal(
      (
        await f.app.inject({ url: "/api/runtime-status", headers: f.headers })
      ).json().activeTask,
      null,
    );
    const id = (
      await f.app.inject({
        method: "POST",
        url: `/api/conversations/${f.conversationId}/messages`,
        headers: f.headers,
        payload: { content: "运行状态验证", idempotencyKey: "runtime-one" },
      })
    ).json().taskId;
    await waitFor(() => !!release);
    const state = (
      await f.app.inject({ url: "/api/runtime-status", headers: f.headers })
    ).json().activeTask;
    assert.equal(state.id, id);
    assert.equal(state.conversationId, f.conversationId);
    assert.deepEqual(Object.keys(state).sort(), [
      "conversationId",
      "createdAt",
      "id",
      "kind",
      "status",
    ]);
    f.db
      .prepare("INSERT INTO users VALUES (?,?,?,?)")
      .run("other-runtime", "other-runtime", "hash", "now");
    const owner = f.db
      .prepare("SELECT user_id FROM tasks WHERE id=?")
      .get(id)!.user_id;
    f.db
      .prepare("UPDATE tasks SET user_id=? WHERE id=?")
      .run("other-runtime", id);
    assert.equal(
      (
        await f.app.inject({ url: "/api/runtime-status", headers: f.headers })
      ).json().activeTask,
      null,
    );
    f.db.prepare("UPDATE tasks SET user_id=? WHERE id=?").run(owner, id);
    await f.app.inject({
      method: "POST",
      url: `/api/tasks/${id}/cancel`,
      headers: f.headers,
    });
    release!();
    await waitFor(
      () =>
        f.db.prepare("SELECT status FROM tasks WHERE id=?").get(id)?.status ===
        "cancelled",
    );
    assert.equal(
      (
        await f.app.inject({ url: "/api/runtime-status", headers: f.headers })
      ).json().activeTask,
      null,
    );
  } finally {
    release?.();
    await f.app.close();
  }
});
