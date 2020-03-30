// powered_goban.js: board renderer + analysis engine
// 
// set_board() indirectly updates displayed board,
// starts analysis of given game state, and updates displayed suggestions.

const {create_game} = require('./game.js')
const {endstate_clusters_for} = require('./area.js')

// state
let endstate_diff_interval = 12, endstate_diff_from = null
let game = create_game()  // dummy empty game until first set_board()
const winrate_trail = true

/////////////////////////////////////////////////
// basic

function set_board(given_game) {
    game = given_game; set_board_size(game.board_size)
    const hist = game.array_until(game.move_count)
    R.move_count = game.move_count = hist.length
    R.bturn = !(hist[hist.length - 1] || {}).is_black
    R.visits = null
    set_stones(game.current_stones())
    return hist.filter(h => !h.illegal)
}

function set_stones(stones) {
    R.stones = stones; add_info_to_stones(R.stones, game)
    R.prev_endstate_clusters = null
    set_tentative_endstate_maybe()  // avoid flicker of ownerships
}

function renew_game() {set_endstate_obsolete(); clear_endstate()}

/////////////////////////////////////////////////
// receive analysis from leelaz

// (obsolete comment & variable. but keep conventional code as far as possible here.)
// This is not equal to R.move_count and game.move_count
// for repeated (fast) undo/redo since showboard is deferred
// in this case for efficiency.
let leelaz_move_count = 0

// (obsolete. but keep conventional code as far as possible here.)
function endstate_handler(h) {
    if (M.is_pausing()) {return}
    const endstate_setter = update_p => {
        const leelaz_move_count = R.endstate_move_count
        const add_endstate_to_history = z => {
            z.endstate = R.endstate; if (!update_p) {return}
            z.endstate_sum = sum(flatten(R.endstate))
        }
        // need add_endstate_to_history before add_endstate_to_stones
        // because update_endstate_diff depends on game.ref_current().endstate
        leelaz_move_count > 0 && add_endstate_to_history(game.ref(leelaz_move_count))
        add_endstate_to_stones(R.stones, R.endstate, leelaz_move_count, update_p)
        set_endstate_uptodate(R.endstate, leelaz_move_count)
    }
    set_renderer_state(h)
    AI.another_leelaz_for_endstate_p() && endstate_setter(!!h.endstate)
}

const too_small_prior = 1e-3
function suggest_handler(h) {
    const considerable = z => z.visits > 0 || z.prior >= too_small_prior
    const mc = game.move_count, cur = game.ref(mc) || {}, {engine_id} = h
    h.suggest = h.suggest.filter(considerable)
    h.ownership && (h.endstate = endstate_from_ownership(h.ownership))
    !cur.by && (cur.by = {}); !cur.by[engine_id] && (cur.by[engine_id] = {})
    const cur_by_engine = cur.by[engine_id]
    const prefer_cached_p = cur_by_engine.visits > h.visits &&
          (!AI.katago_p() || cur_by_engine.komi === h.komi) &&
          (!AI.is_gorule_supported() || !cur_by_engine.gorule || cur_by_engine.gorule === h.gorule)
    const preferred_h = !R.use_cached_suggest ? h :
          prefer_cached_p ? {...h, ...cur_by_engine} : h
    preferred_h.background_visits = (h !== preferred_h) && h.visits
    const copy_vals = (keys, to) =>
          keys.forEach(k => truep(preferred_h[k]) && (to[k] = preferred_h[k]))
    // keys1: required. individual plot for each engine.
    const keys1 = ['suggest', 'visits', 'background_visits', 'b_winrate',
                   'komi', 'gorule']
    copy_vals(keys1, cur); copy_vals(keys1, cur_by_engine)
    // keys2: optional. single global plot.
    const keys2 = ['endstate', 'score_without_komi']
    copy_vals(keys2, cur); !prefer_cached_p && copy_vals(keys2, cur_by_engine)
    game.engines[engine_id] = true
    // if current engine is Leela Zero, recall ownerships by KataGo
    const {endstate, score_without_komi} = {...cur, ...preferred_h}
    R.show_endstate && add_endstate_to_stones(R.stones, endstate, mc, true)
    endstate && set_endstate_uptodate(endstate)
    // is_endstate_drawable is true if...
    // (1) ownership is given here, or
    // (2) endstate_handler() was called already
    const is_endstate_drawable = is_endstate_uptodate()
    set_and_render_maybe({...preferred_h, is_endstate_drawable, score_without_komi})
    on_suggest()
}

/////////////////////////////////////////////////
// change renderer state and send it to renderer

function winrate_history_set_from_game() {
    const current = AI.engine_ids()
    const rest = Object.keys(game.engines).filter(eid => current.indexOf(eid) < 0)
    const f = a => a.map(winrate_from_game)
    return [f(current), f(rest)]
}

function set_renderer_state(...args) {
    merge(R, ...args)  // use updated R in below lines
    const {move_count, handicaps} = game
    const busy = M.is_busy(), long_busy = M.is_long_busy()
    const winrate_history = busy ? [] : winrate_from_game()
    const winrate_history_set = busy ? [[[]], []] : winrate_history_set_from_game()
    const previous_suggest = get_previous_suggest()
    const max_visits = clip(Math.max(...(R.suggest || []).map(h => h.visits)), 1)
    const progress = M.auto_progress()
    const weight_info = weight_info_text()
    const is_katago = AI.katago_p()
    const komi = game.get_komi(), bsize = board_size()
    const comment = game.ref_current().comment || ''
    const endstate_sum = truep(R.score_without_komi) ? R.score_without_komi :
          AI.another_leelaz_for_endstate_p() ? average_endstate_sum() : null
    const endstate = aa_map(R.stones, h => h.endstate || 0)
    const endstate_clusters = get_endstate_clusters(endstate)
    const endstate_d_i = truep(endstate_sum) ? {endstate_diff_interval} : {}
    const invalid_endstate_p =
          (endstate_clusters.length === 1 && endstate_clusters[0].ownership_sum === 0)
    const move_history = [{}, ...game.map(z => ({
        move: z.move, is_black: z.is_black, ko_state: z.ko_state,
        unsafe_stones: z.unsafe_stones, ambiguity: z.ambiguity
    }))]
    merge(R, {move_count, handicaps, busy, long_busy,
              winrate_history, winrate_history_set,
              endstate_sum, endstate_clusters, max_visits, progress,
              weight_info, is_katago, komi, bsize, comment, move_history,
              previous_suggest, winrate_trail}, endstate_d_i)
}
function set_and_render(...args) {set_and_render_gen(true, ...args)}
function set_and_render_maybe(...args) {set_and_render_gen(false, ...args)}
function set_and_render_gen(is_board_changed, ...args) {
    set_renderer_state(...args)
    const mask = M.show_suggest_p() ? {} :
          {suggest: [], visits: null, show_endstate: false}
    M.render({...R, ...mask}, is_board_changed)
}

/////////////////////////////////////////////////
// endstate

let endstate_array, endstate_move_count
function set_endstate_uptodate(endstate, move_count) {
    endstate_array = endstate
    endstate_move_count = truep(move_count) ? move_count : game.move_count
}
function set_endstate_obsolete() {[endstate_array, endstate_move_count] = [null, null]}
function is_endstate_uptodate() {return endstate_move_count === game.move_count}
function is_endstate_nearly_uptodate(lim) {
    return Math.abs(endstate_move_count - game.move_count) <= lim
}
function recall_endstate() {return endstate_array}
set_endstate_obsolete()

function append_endstate_tag_maybe(h) {
    const h_copy = merge({}, h)
    AI.support_endstate_p() && R.show_endstate &&
        h.move_count === game.move_count - endstate_diff_interval &&
        h.move_count >= game.handicaps &&
        add_tag(h_copy, endstate_diff_tag_letter)
    return h_copy
}
function get_endstate_diff_interval() {return endstate_diff_interval}
function set_endstate_diff_interval(k) {endstate_diff_interval = k}
function set_endstate_diff_from(k) {
    change_endstate_diff_target(() => {endstate_diff_from = k})
}
function change_endstate_diff_target(proc) {
    const old = endstate_diff_move_count()
    proc()
    endstate_diff_move_count() !== old && update_endstate_diff()
}

function set_tentative_endstate_maybe() {
    const {endstate} = game.ref_current(), pausing = M.is_pausing()
    const update_p = endstate && !pausing
    const reuse_p = !M.is_busy() && is_endstate_nearly_uptodate(pausing ? 0 : 20)
    update_p ? set_endstate_uptodate(endstate) :
        reuse_p ? do_nothing() : set_endstate_obsolete()
    const es = recall_endstate()
    tentatively_add_endstate_to_stones(R.stones, es)
    R.is_endstate_drawable = !!es
}

function add_endstate_to_stones(stones, endstate, move_count, update_diff_p) {
    // if (!endstate) {return}
    purely_add_endstate_to_stones(stones, endstate)
    update_diff_p && update_endstate_diff()
    merge(game.ref(move_count), get_ambiguity_etc(stones, game, move_count))
}
function tentatively_add_endstate_to_stones(stones, endstate) {
    // if (!endstate) {return}
    purely_add_endstate_to_stones(stones, endstate)
    update_endstate_diff(true)
}
const lagged_endstate = make_lagged_aa(0.2)
function purely_add_endstate_to_stones(stones, endstate) {
    const aa = lagged_endstate.update_all(M.is_busy() ? null : endstate)
    aa_each(stones, (s, i, j) => {s.endstate = aa_ref(aa, i, j)})
}

const lagged_endstate_diff = make_lagged_aa(0.2)
function update_endstate_diff(tentatively) {
    const prev = endstate_diff_move_count(), sign = prev < game.move_count ? 1 : -1
    const prev_endstate = game.ref(prev).endstate
    const ok = prev_endstate && game.ref_current().endstate
    const tentatively_ok = prev_endstate && tentatively
    aa_each(R.stones, (s, i, j) => {
        const val = (ok || tentatively_ok) && !M.is_busy() ?
              sign * (s.endstate - aa_ref(prev_endstate, i, j)) : 0
        s.endstate_diff = lagged_endstate_diff.update(i, j, val)
    })
    R.prev_endstate_clusters = ok && get_endstate_clusters(prev_endstate, prev)
}
function endstate_diff_move_count() {
    const edf = endstate_diff_from, mc = game.move_count
    return (truep(edf) && edf !== mc) ? edf : (mc - endstate_diff_interval)
}
function average_endstate_sum(move_count) {
    return for_current_and_previous_endstate(move_count, 'endstate_sum', 1,
                                             (cur, prev) => (cur + prev) / 2)
}
function for_current_and_previous_endstate(move_count, key, delta, f) {
    const mc = truep(move_count) || game.move_count
    const [cur, prev] = [0, delta].map(k => game.ref(mc - k)[key])
    return truep(cur) && truep(prev) && f(cur, prev)
}
function add_tag(h, tag) {h.tag = str_uniq((h.tag || '') + (tag || ''))}

function clear_endstate() {lagged_endstate.reset(); lagged_endstate_diff.reset()}

function get_endstate_clusters(endstate, move_count) {
    const stones = M.is_bogoterritory() &&
          (move_count ? game.stones_at(move_count) : R.stones)
    return endstate_clusters_for(endstate, stones)
}

function get_ambiguity_etc(stones, game, move_count) {
    // ambiguity = sum of (1 - |ownership|) for all stones on the board.
    // unsafe_stones.black
    //   = number of captured black stones + sum[1 - f(ownership)]
    //   = number of black moves - sum[f(ownership)],
    // where sum[*] is taken for all black stones on the board
    // and f(x) = x (x > 0), 0 (x <= 0).
    let ambiguity = 0, unsafe_stones = {black: 0, white: 0}
    const add_to_unsafe_stones = (black_p, val) => {
        unsafe_stones[black_p ? 'black' : 'white'] += val
    }
    const count_played_stones = () =>
          game.array_until(move_count).forEach(({move, is_black}) => {
              const pass = move2idx(move)[0] < 0
              !pass && add_to_unsafe_stones(is_black, 1)
          })
    const check_endstate = h => {
        const is_target = h.stone && truep(h.endstate); if (!is_target) {return}
        const es = Math.abs(h.endstate), dead = xor(h.black, h.endstate > 0)
        ambiguity += 1 - es
        !dead && add_to_unsafe_stones(h.black, - es)
    }
    count_played_stones(); aa_each(stones, check_endstate)
    return {ambiguity, unsafe_stones}
}

function make_lagged_aa(max_diff) {
    let aa = [[]]
    const update = (i, j, val) => {
        const prev = aa_ref(aa, i, j) || 0, given = val || 0
        const updated = clip(given, prev - max_diff, prev + max_diff)
        aa_set(aa, i, j, updated); return updated
    }
    const update_all = new_aa => {
        aa_each(new_aa || aa, (_, i, j) => update(i, j, aa_ref(new_aa || [[]], i, j)))
        return aa
    }
    const reset = () => (aa = [[]])
    return {update, update_all, reset}
}

/////////////////////////////////////////////////
// winrate history

function winrate_from_game(engine_id) {
    // +1 for move_count (see game.js)
    const winrates = seq(game.len() + 1).map(mc => get_b_winrate(mc, engine_id))
    const score_loss = {b: 0, w: 0}; let prev_score = game.get_komi()
    return winrates.map((r, s, a) => {
        const cur = game.ref(s)
        const [turn_letter, opponent_letter, turn_sign] =
              cur.is_black ? ['b', 'w', 1] : ['w', 'b', -1]
        const h = append_endstate_tag_maybe(cur), tag = h.tag
        if (!truep(r)) {return {tag}}
        const move_b_eval = a[s - 1] && (r - a[s - 1])
        const move_eval = move_b_eval && move_b_eval * turn_sign
        const predict = winrate_suggested(s, engine_id)
        const implicit_pass = (!!h.is_black === !!game.ref(s - 1).is_black)
        const pass = implicit_pass || M.is_pass(h.move) || h.illegal
        const score_without_komi = score_without_komi_at(s)
        const record_gain_as_side_effect = gain => {
            if (engine_id || s === 0 || !truep(score_without_komi_at(s - 1))) {return}
            merge(cur, {gain})
            s <= game.move_count &&
                merge(aa_ref(R.stones, ...move2idx(cur.move)) || {}, {gain})
        }
        const update_score_loss = gain => {
            // (A) gain < 0: Your move is bad.
            // (B) gain > 0: Your move is good or the opponent's last move was bad.
            // The case (B) never happens if the engine is perfectly accurate.
            // So we cannot trust positive gains literally.
            const responsibility_of_opponent = 0.5
            const transferred = clip(gain, 0) * responsibility_of_opponent
            const loss = - (gain - transferred)
            score_loss[turn_letter] += loss
            score_loss[opponent_letter] += transferred
            record_gain_as_side_effect(gain)  // clean me
        }
        const update_score_loss_maybe = () => {
            const gain = (score_without_komi - prev_score) * turn_sign
            const valid = !pass || s === 0; valid && update_score_loss(gain)
            prev_score = score_without_komi
        }
        truep(score_without_komi) && update_score_loss_maybe()
        const cumulative_score_loss = {...score_loss}  // dup
        // drop "pass" to save data size for IPC
        return merge({
            r, move_b_eval, move_eval, tag, score_without_komi, cumulative_score_loss,
        }, pass ? {pass} : {predict})
    })
}

function score_without_komi_at(move_count) {
    const ret = game.ref(move_count).score_without_komi
    return truep(ret) ? ret : average_endstate_sum(move_count)
}

function get_initial_b_winrate(engine_id) {return get_b_winrate(0, engine_id)}
function get_b_winrate(move_count, engine_id) {
    const ret = get_estimation(move_count, engine_id).b_winrate
    return truep(ret) ? ret : NaN
}
function get_estimation(move_count, engine_id) {
    const m = game.ref(move_count)
    return truep(engine_id) ? ((m.by || {})[engine_id] || {}) : m
}

function winrate_suggested(move_count, engine_id) {
    const {move, is_black} = game.ref(move_count)
    const {suggest} = get_estimation(move_count - 1, engine_id)
    const sw = ((suggest || []).find(h => h.move === move && h.visits > 0) || {}).winrate
    return truep(sw) && (is_black ? sw : 100 - sw)
}

/////////////////////////////////////////////////
// misc. utils for updating renderer state

function get_previous_suggest() {
    const [cur, prev] = [0, 1].map(k => game.ref(game.move_count - k))
    // avoid "undefined" and use "null" for merge in set_renderer_state
    const ret = (prev.suggest || []).find(h => h.move === (cur.move || '')) || null
    ret && (ret.bturn = !prev.is_black)
    return ret
}
function weight_info_text() {
    const h = AI.engine_info(), ek = h.engine_komi, gk = game.get_komi()
    const game_komi = truep(gk) && gk != ek && ` (game komi=${gk})`
    const s = val => truep(val) ? to_s(val) : ''
    const engine_komi = (game_komi || (ek !== leelaz_komi)) ?
          `komi=${ek}${s(game_komi)} ` : ''
    const game_gorule = AI.is_gorule_supported() && game.gorule
    const gorule = game_gorule ? `(${game_gorule}) ` : ''
    const f = z => z ?
          `${z.preset_label_text} ${s(z.network_size)}${s(!z.is_ready && '(waiting...)')}` : ''
    const weight_info = h.leelaz_for_white_p ?
          `${f(h.black)} / ${f(h.white)}` : f(h.black)
    const tuning = M.tuning_message()
    return engine_komi + gorule + weight_info + (tuning ? ` | ${tuning}` : '')
}
function add_next_mark_to_stones(stones, game, move_count) {
    const h = game.ref(move_count + 1), s = stone_for_history_elem(h, stones)
    s && (s.next_move = true) && (s.next_is_black = h.is_black)
}
function add_info_to_stones(stones, game) {
    game.forEach((h, c) => {
        const s = stone_for_history_elem(h, stones); if (!s) {return}
        add_tag(s, h.tag)
        s.stone && (h.move_count <= game.move_count) && (s.move_count = h.move_count)
        !s.anytime_stones && (s.anytime_stones = [])
        s.anytime_stones.push(pick_properties(h, ['move_count', 'is_black']))
    })
    add_next_mark_to_stones(stones, game, game.move_count)
}
function update_info_in_stones() {
    clear_info_in_stones(R.stones); add_info_to_stones(R.stones, game)
}
function clear_info_in_stones(stones) {
    const keys = ['move_count', 'tag', 'anytime_stones',
                  'next_move', 'next_is_black']
    aa_each(stones, s => keys.forEach(key => {delete s[key]}))
}
function stone_for_history_elem(h, stones) {
    return h && h.move && aa_ref(stones, ...move2idx(h.move))
}
function pick_properties(orig, keys) {
    const ret = {}; keys.forEach(k => ret[k] = orig[k]); return ret
}

/////////////////////////////////////////////////
// exports

AI.set_handlers({suggest_handler, endstate_handler})

module.exports = {
    // basic
    set_board,
    // endstate
    append_endstate_tag_maybe,
    get_endstate_diff_interval, set_endstate_diff_interval, set_endstate_diff_from,
    // renderer
    set_and_render,
    // util
    stone_for_history_elem, update_info_in_stones, weight_info_text,
    get_initial_b_winrate, add_info_to_stones, renew_game,
}
