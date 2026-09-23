// 路网：节点、有向边、行驶秒数；道路封闭按边切断。
// 路线临时调整后，原来纸面达标的救护车可能因为封路绕远甚至无法到达，
// 因此每次演练/回放都必须在「当时生效的封闭集合」上重新计算行驶时间。

import { t } from "./time_windows.js";

export class RoadNetwork {
  constructor() {
    this.nodes = new Map(); // nodeId -> { id, position? }
    this.edges = new Map(); // edgeId -> { id, from, to, seconds }
    this.closures = []; // { id, edgeIds:Set, window:{start,end} }
  }

  addNode(id, position = null) {
    if (!this.nodes.has(id)) this.nodes.set(id, { id, position });
    return this;
  }

  addEdge(id, from, to, seconds) {
    this.addNode(from);
    this.addNode(to);
    if (seconds <= 0) throw new Error(`边行驶时间必须为正: ${id}`);
    // 同一条边重复声明取后值（路线调整时覆盖），但保留 from/to 一致。
    this.edges.set(id, { id, from, to, seconds });
    return this;
  }

  addClosure(closure) {
    const edgeIds = new Set(closure.edges);
    for (const edgeId of edgeIds) {
      if (!this.edges.has(edgeId)) throw new Error(`封闭了不存在的边: ${edgeId}`);
    }
    this.closures.push({
      id: closure.closure_id ?? closure.id,
      edgeIds,
      window: { start: t(closure.window.start), end: t(closure.window.end) },
    });
    return this;
  }

  // 克隆路网用于演练情景：叠加假设封闭/调整，不污染已发布版本使用的基线。
  clone() {
    const copy = new RoadNetwork();
    for (const [id, node] of this.nodes) copy.nodes.set(id, { ...node });
    for (const [id, edge] of this.edges) copy.edges.set(id, { ...edge });
    copy.closures = this.closures.map((c) => ({ id: c.id, edgeIds: new Set(c.edgeIds), window: { ...c.window } }));
    return copy;
  }

  // 某时刻被封闭的边集合。
  closedEdgesAt(atMs) {
    const closed = new Set();
    for (const c of this.closures) {
      if (atMs >= c.window.start && atMs < c.window.end) {
        for (const e of c.edgeIds) closed.add(e);
      }
    }
    return closed;
  }

  _adjacency(closed) {
    const adj = new Map();
    for (const edge of this.edges.values()) {
      if (closed.has(edge.id)) continue;
      if (!adj.has(edge.from)) adj.set(edge.from, []);
      adj.get(edge.from).push(edge);
    }
    return adj;
  }

  // Dijkstra：返回最快路径 { path:[nodeId...], edges:[edgeId...], seconds }，不可达返回 null。
  fastestPath(fromId, toId, atMs = 0) {
    if (!this.nodes.has(fromId) || !this.nodes.has(toId)) {
      throw new Error("路径端点不在路网中");
    }
    const closed = typeof atMs === "number" && atMs > 0 ? this.closedEdgesAt(atMs) : new Set();
    const adj = this._adjacency(closed);
    const dist = new Map([[fromId, 0]]);
    const prev = new Map();
    const visited = new Set();
    const queue = [fromId];

    while (queue.length) {
      queue.sort((a, b) => dist.get(a) - dist.get(b));
      const node = queue.shift();
      if (visited.has(node)) continue;
      visited.add(node);
      if (node === toId) break;
      for (const edge of adj.get(node) ?? []) {
        const alt = dist.get(node) + edge.seconds;
        if (alt < (dist.get(edge.to) ?? Infinity)) {
          dist.set(edge.to, alt);
          prev.set(edge.to, edge);
          if (!visited.has(edge.to)) queue.push(edge.to);
        }
      }
    }
    if (!dist.has(toId)) return null;
    const edges = [];
    const path = [toId];
    let cur = toId;
    while (cur !== fromId) {
      const edge = prev.get(cur);
      edges.unshift(edge.id);
      cur = edge.from;
      path.unshift(cur);
    }
    return Object.freeze({ path, edges, seconds: dist.get(toId) });
  }

  // 校验人工选择的路径：必须真实可行（经过的边存在且当时未封闭、首尾相连），
  // 且当慢于系统最快路径时必须提供理由——理由进入事件，回放时可审计。
  validateChosenPath(fromId, toId, chosenEdges, atMs, reason) {
    const closed = this.closedEdgesAt(atMs);
    let cursor = fromId;
    let seconds = 0;
    for (const edgeId of chosenEdges) {
      const edge = this.edges.get(edgeId);
      if (!edge) return { ok: false, error: `路径引用了不存在的边: ${edgeId}` };
      if (edge.from !== cursor) return { ok: false, error: `边 ${edgeId} 不衔接当前位置 ${cursor}` };
      if (closed.has(edgeId)) return { ok: false, error: `边 ${edgeId} 在该时段已封闭` };
      cursor = edge.to;
      seconds += edge.seconds;
    }
    if (cursor !== toId) return { ok: false, error: "人工路径未到达目标点" };

    const fastest = this.fastestPath(fromId, toId, atMs);
    const result = {
      ok: true,
      path: chosenEdges,
      seconds,
      fastest_seconds: fastest ? fastest.seconds : null,
      detour_seconds: fastest ? seconds - fastest.seconds : null,
      reason_required: fastest ? seconds > fastest.seconds : true,
    };
    if (result.reason_required && !(typeof reason === "string" && reason.trim().length >= 4)) {
      return {
        ok: false,
        error: fastest
          ? `人工路径比最快路径慢 ${result.detour_seconds}s，必须在 ROUTE_CHOSEN 中留下理由`
          : "目标点当时不可达或无最快路径，仍必须说明选择该路径的理由",
      };
    }
    return result;
  }
}
