// 现场消息流：无线网络中断期间，设备在本地缓存位置/伤情消息，恢复后批量回传。
//
// 合并规则：
// - 每条消息带「来源 source + 来源内单调序号 seq + 设备发送时刻 sent_at」。
// - 按 (source, seq) 归并：乱序到达先缓冲，缺口补齐后按序释放；重复投递去重。
// - 事实投影只接受序号连续的前缀，迟到的旧消息永远不能把新事实改回旧状态。
// - 转运状态机单调推进；HANDOFF_COMPLETED 与 COMPLETED 是吸收态，不可回退。

import { t } from "./time_windows.js";

export const MESSAGE_KINDS = Object.freeze(["LOCATION", "TRIAGE", "TRANSPORT_STATUS"]);

export const TRANSPORT_STAGES = Object.freeze({
  DECLARED: 1,
  EN_ROUTE: 2,
  AT_HOSPITAL: 3,
  COMPLETED: 4,
});

export class MessageError extends Error {}

function msgKey(msg) {
  return `${msg.source}#${msg.seq}`;
}

export class FieldMessageLog {
  constructor() {
    this._messages = new Map(); // source#seq -> 规范化消息
    this._sources = new Map(); // source -> { watermark, skipped:Set }
  }

  // 接收一条（或一批）恢复后回传的消息；返回新入库的条数（重复投递不计）。
  receive(record) {
    const records = Array.isArray(record) ? record : [record];
    let added = 0;
    for (const r of records) {
      const msg = this._normalize(r);
      const key = msgKey(msg);
      if (this._messages.has(key)) continue; // 重传去重
      this._messages.set(key, msg);
      if (!this._sources.has(msg.source)) {
        this._sources.set(msg.source, { watermark: 0, skipped: new Set() });
      }
      added += 1;
    }
    return added;
  }

  _normalize(r) {
    const p = r.kind === "FIELD_MESSAGE_RECEIVED" ? r.payload : r;
    if (!p || typeof p.source !== "string" || !Number.isInteger(p.seq) || p.seq <= 0) {
      throw new MessageError("消息必须包含正整数 seq 与 source");
    }
    const sentAt = t(p.sent_at);
    if (!Number.isFinite(sentAt)) throw new MessageError(`消息 ${p.source}#${p.seq} 缺少 sent_at`);
    if (!MESSAGE_KINDS.includes(p.body?.kind)) {
      throw new MessageError(`消息 ${p.source}#${p.seq} 的 body.kind 非法`);
    }
    return {
      source: p.source,
      seq: p.seq,
      sent_at: sentAt,
      received_at: t(p.received_at ?? r.occurred_at ?? p.sent_at),
      body: p.body,
    };
  }

  _state(source) {
    return this._sources.get(source);
  }

  // 尚未收到的序号（1 与当前最大序号之间）。
  missingSeqs(source) {
    const seqs = [...this._messages.values()].filter((m) => m.source === source).map((m) => m.seq);
    if (!seqs.length) return [];
    const max = Math.max(...seqs);
    const have = new Set(seqs);
    const state = this._state(source);
    const out = [];
    for (let i = 1; i <= max; i++) {
      if (!have.has(i) && !state.skipped.has(i)) out.push(i);
    }
    return out;
  }

  // 运营确认某序号永久丢失（设备损毁等），跳过它并留痕。
  markLost(source, seq, reason) {
    const state = this._state(source);
    if (!state) throw new MessageError(`未知来源: ${source}`);
    if (this._messages.has(`${source}#${seq}`)) {
      throw new MessageError(`${source}#${seq} 实际已收到，不能标记丢失`);
    }
    state.skipped.add(seq);
    state.lost ??= [];
    state.lost.push({ seq, reason });
  }

  // 按来源序号释放连续前缀。缺口未补齐时，缺口之后的消息保持缓冲（绝不抢先生效）。
  releaseContinuous(source) {
    const state = this._state(source);
    if (!state) return [];
    const released = [];
    for (;;) {
      const next = state.watermark + 1;
      const msg = this._messages.get(`${source}#${next}`);
      if (msg) {
        state.watermark = next;
        released.push(msg);
      } else if (state.skipped.has(next)) {
        state.watermark = next; // 跳过已确认丢失的序号
      } else {
        break;
      }
    }
    return released;
  }

  bufferedCount(source) {
    const state = this._state(source);
    if (!state) return 0;
    return [...this._messages.values()].filter((m) => m.source === source && m.seq > state.watermark).length;
  }

  get sources() {
    return [...this._sources.keys()];
  }

  // 全量按来源序列合并：先按 source 归组、组内按 seq；跨来源再按 sent_at 排全局次序。
  merged() {
    const bySource = new Map();
    for (const msg of this._messages.values()) {
      if (!bySource.has(msg.source)) bySource.set(msg.source, []);
      bySource.get(msg.source).push(msg);
    }
    const ordered = [];
    for (const [source, list] of bySource) {
      const state = this._state(source);
      list
        .filter((m) => m.seq <= state.watermark)
        .sort((a, b) => a.seq - b.seq)
        .forEach((m) => ordered.push(m));
    }
    return ordered.sort((a, b) => a.sent_at - b.sent_at || a.source.localeCompare(b.source) || a.seq - b.seq);
  }

  replay() {
    const out = [];
    for (const source of this.sources) out.push(...this.releaseContinuous(source));
    return out.sort((a, b) => a.sent_at - b.sent_at || a.source.localeCompare(b.source) || a.seq - b.seq);
  }
}

// 事件/消息 -> 每起事件（incident）的事实表。
// 转运阶段单调；位置/伤情以「更高来源序号」为准，迟到旧消息只入档不改写。
export class IncidentFacts {
  constructor() {
    this.incidents = new Map();
    this.rejected = []; // 被单调性规则挡下的迟到/回退消息，审计可见
  }

  _incident(id) {
    if (!this.incidents.has(id)) {
      this.incidents.set(id, {
        incident_id: id,
        transport: { stage: null, source: null, seq: -1 },
        triage: null,
        location: null,
        timeline: [],
      });
    }
    return this.incidents.get(id);
  }

  // 服务端权威事件：交接完成即转运完成（吸收态）。
  applyHandoff(event) {
    if (event.kind !== "HANDOFF_COMPLETED") throw new MessageError("仅接受 HANDOFF_COMPLETED 事件");
    const inc = this._incident(event.payload.incident_id);
    inc.transport = {
      stage: "COMPLETED",
      source: "registry",
      seq: Infinity,
      hospital_id: event.payload.hospital_id,
      at: t(event.payload.at),
    };
    inc.timeline.push({ kind: "HANDOFF_COMPLETED", at: t(event.occurred_at), hospital_id: event.payload.hospital_id });
  }

  applyMessage(msg) {
    const body = msg.body;
    const inc = this._incident(body.incident_id);
    const stamp = { source: msg.source, seq: msg.seq, sent_at: msg.sent_at, received_at: msg.received_at };

    if (body.kind === "TRANSPORT_STATUS") {
      const next = body.stage;
      if (!(next in TRANSPORT_STAGES)) {
        throw new MessageError(`未知转运阶段: ${next}`);
      }
      // 已完成是吸收态：任何较晚到达的非完成消息都不能回退（优先于序号检查，
      // 这样设备重传的旧序号也被明确记录为「完成后迟到」而非普通乱序）。
      if (inc.transport.stage === "COMPLETED" && next !== "COMPLETED") {
        this.rejected.push({ ...stamp, incident_id: inc.incident_id, reason: "COMPLETION_ABSORBING" });
        return false;
      }
      // 同一来源内序号倒退 -> 旧消息迟到，拒绝。
      if (msg.source === inc.transport.source && msg.seq < inc.transport.seq) {
        this.rejected.push({ ...stamp, incident_id: inc.incident_id, reason: "STALE_SEQ" });
        return false;
      }
      // 阶段不可倒退（即使来自不同来源，以已生效事实为准）。
      if (inc.transport.stage && TRANSPORT_STAGES[next] < TRANSPORT_STAGES[inc.transport.stage]) {
        this.rejected.push({
          ...stamp, incident_id: inc.incident_id,
          reason: "STAGE_REGRESSION", from: inc.transport.stage, attempted: next,
        });
        return false;
      }
      inc.transport = { stage: next, source: msg.source, seq: msg.seq, at: msg.sent_at };
      inc.timeline.push({ kind: "TRANSPORT_STATUS", stage: next, ...stamp });
      return true;
    }

    if (body.kind === "TRIAGE") {
      const newer = !inc.triage ||
        msg.sent_at > inc.triage.sent_at ||
        (msg.sent_at === inc.triage.sent_at && msg.seq > inc.triage.seq);
      if (!newer) {
        this.rejected.push({ ...stamp, incident_id: inc.incident_id, reason: "STALE_TRIAGE" });
        return false;
      }
      inc.triage = { severity: body.severity, note: body.note ?? null, ...stamp };
      inc.timeline.push({ kind: "TRIAGE", severity: body.severity, ...stamp });
      return true;
    }

    if (body.kind === "LOCATION") {
      const newer = !inc.location ||
        msg.sent_at > inc.location.sent_at ||
        (msg.sent_at === inc.location.sent_at && msg.seq > inc.location.seq);
      if (!newer) {
        this.rejected.push({ ...stamp, incident_id: inc.incident_id, reason: "STALE_LOCATION" });
        return false;
      }
      inc.location = { node: body.node ?? null, geo: body.geo ?? null, ...stamp };
      inc.timeline.push({ kind: "LOCATION", ...inc.location });
      return true;
    }
    return false;
  }

  // 从日志按来源序列重放，构建事实表。
  static fromLog(log, handoffEvents = []) {
    const facts = new IncidentFacts();
    for (const e of handoffEvents) facts.applyHandoff(e);
    for (const msg of log.replay()) facts.applyMessage(msg);
    return facts;
  }
}
