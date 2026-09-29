/**
 * Seating Chart App - 65th Anniversary PCCC & CNCH
 * Layout: 3 rows with tables (front) + 8 rows without tables (back)
 * 10 seats per side, 20 per row, total 11 rows = 220 seats
 * Only seats for: guests + C07 leadership + department heads (TP/PTP)
 */

// ============================================================
// DATA & STATE
// ============================================================

const SEATS_PER_SIDE = 10;
const SEATS_PER_ROW = SEATS_PER_SIDE * 2; // 20
const TABLE_ROWS = 3;   // 3 dãy đầu có bàn
const BACK_ROWS = 8;    // 8 dãy sau không bàn
const TOTAL_ROWS = TABLE_ROWS + BACK_ROWS; // 11
const TOTAL_SEATS = TOTAL_ROWS * SEATS_PER_ROW; // 220

let seatingData = null;       // Raw data from JSON
let seatMap = {};             // seatCode -> person data
let history = [];             // Undo history
let currentZoom = 100;
let showSeatCodes = true;
let swapMode = false;
let swapSourceCode = null;
let contextMenu = null;

// ============================================================
// INITIALIZATION
// ============================================================

document.addEventListener('DOMContentLoaded', async () => {
    await loadData();
    buildChart();
    populateSeats();
    updateStats();
    setupKeyboardShortcuts();
    setupContextMenu();
});

async function loadData() {
    try {
        // Try fetch first (works with http/https)
        const resp = await fetch('seating_data.json');
        seatingData = await resp.json();
    } catch (e) {
        console.warn('fetch failed, trying XMLHttpRequest fallback:', e.message);
        try {
            // Fallback for file:// protocol
            seatingData = await new Promise((resolve, reject) => {
                const xhr = new XMLHttpRequest();
                xhr.open('GET', 'seating_data.json', true);
                xhr.onload = () => {
                    if (xhr.status === 200 || xhr.status === 0) {
                        resolve(JSON.parse(xhr.responseText));
                    } else {
                        reject(new Error('XHR status: ' + xhr.status));
                    }
                };
                xhr.onerror = () => reject(new Error('XHR failed'));
                xhr.send();
            });
        } catch (e2) {
            console.error('All loading methods failed:', e2);
            showToast('Không thể tải dữ liệu! Hãy mở qua http://localhost:8080', 'error');
        }
    }
}

// ============================================================
// BUILD CHART DOM
// ============================================================

function buildChart() {
    // Build 3 front rows with tables
    buildRows('tableSeating', TABLE_ROWS, 1, true);
    // Build 8 back rows without tables
    buildRows('backSeating', BACK_ROWS, TABLE_ROWS + 1, false);
}

function buildRows(containerId, numRows, startRowNum, hasTables) {
    const container = document.getElementById(containerId);
    container.innerHTML = '';

    for (let r = 0; r < numRows; r++) {
        const rowNum = startRowNum + r;
        const rowEl = document.createElement('div');
        rowEl.className = `seat-row${hasTables ? ' has-table' : ''}`;

        // Row label
        const label = document.createElement('div');
        label.className = 'row-label';
        label.textContent = `${rowNum}`;
        rowEl.appendChild(label);

        // Left block (seats 1-10)
        const leftBlock = document.createElement('div');
        leftBlock.className = 'row-block';
        for (let s = 1; s <= SEATS_PER_SIDE; s++) {
            const code = `R${rowNum}-${String(s).padStart(2, '0')}`;
            const seat = createSeatElement(code);
            leftBlock.appendChild(seat);
        }
        rowEl.appendChild(leftBlock);

        // Center aisle
        const aisle = document.createElement('div');
        aisle.className = 'row-aisle';
        rowEl.appendChild(aisle);

        // Right block (seats 11-20)
        const rightBlock = document.createElement('div');
        rightBlock.className = 'row-block';
        for (let s = SEATS_PER_SIDE + 1; s <= SEATS_PER_ROW; s++) {
            const code = `R${rowNum}-${String(s).padStart(2, '0')}`;
            const seat = createSeatElement(code);
            rightBlock.appendChild(seat);
        }
        rowEl.appendChild(rightBlock);

        container.appendChild(rowEl);
    }
}

function createSeatElement(code) {
    const seat = document.createElement('div');
    seat.className = 'seat empty-seat';
    seat.id = `seat-${code}`;
    seat.dataset.code = code;

    seat.innerHTML = `
        <div class="seat-name">Trống</div>
        <div class="seat-rank"></div>
        <div class="seat-position"></div>
        <div class="seat-code${showSeatCodes ? '' : ' hidden'}">${code}</div>
    `;

    seat.addEventListener('click', (e) => onSeatClick(code, e));
    seat.addEventListener('contextmenu', (e) => onSeatRightClick(code, e));

    return seat;
}

// ============================================================
// POPULATE SEATS WITH DATA
// ============================================================

function populateSeats() {
    if (!seatingData) return;

    seatMap = {};

    // Try to load saved arrangement from localStorage
    const saved = localStorage.getItem('seatingArrangement_65_v6');
    if (saved) {
        try {
            seatMap = JSON.parse(saved);
            applySeatMap();
            showToast('Đã tải sơ đồ đã lưu', 'info');
            return;
        } catch (e) {
            console.warn('Invalid saved data, generating new arrangement');
        }
    }

    generateDefaultArrangement();
    applySeatMap();
}

/**
 * Leadership position checker - returns true for department heads
 */
function isLeadershipPosition(position) {
    if (!position) return false;
    const p = position.trim();
    const leadershipTitles = [
        'Cục trưởng', 'PCT',
        'TP', 'PTP',
        'GĐTT', 'PGĐTT',
        'Viện trưởng', 'PVT',
        'Chánh TT', 'Phó CTT',
        'Nguyên Cục trưởng'
    ];
    return leadershipTitles.some(t => p === t || p.includes(t));
}

/**
 * Compute a priority score for sorting.
 * Returns [orgLevel, headVsDeputy, currentVsFormer, rankScore]
 *
 * Chức vụ trước, cấp hàm sau:
 * 1. orgLevel: 1=Bộ, 2=Tổng Cục, 3=Cục, 4=Phòng, 5=Other
 * 2. headVsDeputy: 1=Trưởng, 2=Phó, 3=Other
 * 3. currentVsFormer: 1=Đương nhiệm, 2=Nguyên (nghỉ hưu)
 * 4. rankScore: military rank (1=Đại tướng ... 11=Trung úy, 99=unknown)
 */
function computePriorityScore(person) {
    const pos = (person.position || '').trim();

    // --- Org Level (chức vụ cấp nào) ---
    let orgLevel = 5;
    if (/bộ trưởng|thứ trưởng/i.test(pos)) {
        orgLevel = 1; // Bộ
    } else if (/tổng cục/i.test(pos)) {
        orgLevel = 2; // Tổng Cục
    } else if (/cục trưởng|cục phó|phó cục|PCT|nguyên cục/i.test(pos)) {
        orgLevel = 3; // Cục
    } else if (/trưởng phòng|phó trưởng phòng|phó phòng|^TP$|^PTP$|GĐTT|PGĐTT|viện trưởng|PVT|chánh t|phó ct|giám đốc|phó giám đốc/i.test(pos)) {
        orgLevel = 4; // Phòng
    }

    // --- Head vs Deputy (trưởng hay phó) ---
    let headVsDeputy = 3; // default: other
    if (/^bộ trưởng$/i.test(pos) ||
        /^tổng cục trưởng/i.test(pos) ||
        /^cục trưởng/i.test(pos) ||
        /nguyên cục trưởng/i.test(pos) ||
        /^TP$/i.test(pos) ||
        /^trưởng phòng/i.test(pos) ||
        /^GĐTT$/i.test(pos) ||
        /^giám đốc/i.test(pos) ||
        /^viện trưởng/i.test(pos) ||
        /^chánh t/i.test(pos)) {
        headVsDeputy = 1; // Head
    } else if (/thứ trưởng/i.test(pos) ||
        /phó tổng cục/i.test(pos) ||
        /phó cục|^PCT$/i.test(pos) ||
        /^PTP$/i.test(pos) ||
        /phó trưởng phòng/i.test(pos) ||
        /^PGĐTT$/i.test(pos) ||
        /phó giám đốc/i.test(pos) ||
        /^PVT$/i.test(pos) ||
        /phó ct|^phó chánh/i.test(pos)) {
        headVsDeputy = 2; // Deputy
    }

    // --- Current vs Former (đương nhiệm hay nguyên) ---
    let currentVsFormer = 1; // default: current
    if (/nguyên/i.test(pos)) {
        currentVsFormer = 2; // former/retired
    }
    // Guests in sections II-IV are retired leaders
    if (person.section_num && ['II', 'III', 'IV', 'V', 'VI'].includes(person.section_num)) {
        currentVsFormer = 2;
    }

    // --- Military Rank Score (cấp hàm — tiebreaker) ---
    const rank = (person.rank || '').trim();
    let rankScore = 99;
    const rankMap = [
        ['Đại tướng', 1],
        ['Thượng tướng', 2],
        ['Trung tướng', 3],
        ['Thiếu tướng', 4],
        ['Đại tá', 5],
        ['Thượng tá', 6],
        ['Trung tá', 7],
        ['Thiếu tá', 8],
        ['Đại úy', 9],
        ['Thượng úy', 10],
        ['Trung úy', 11],
    ];
    for (const [rk, score] of rankMap) {
        if (rank.includes(rk)) {
            rankScore = score;
            break;
        }
    }

    return [orgLevel, headVsDeputy, currentVsFormer, rankScore];
}

function generateDefaultArrangement() {
    seatMap = {};

    const guests = seatingData.guests;
    const cbcs = seatingData.cbcs;

    const cssMap = {
        'I': 'section-1', 'II': 'section-2', 'III': 'section-3', 'IV': 'section-4',
        'V': 'section-5', 'VI': 'section-6', 'VII': 'section-7',
        'VIII': 'section-8', 'IX': 'section-9', 'X': 'section-10', 'XI': 'section-11'
    };

    function sortByPriority(arr) {
        return [...arr].sort((a, b) => {
            const sa = computePriorityScore(a);
            const sb = computePriorityScore(b);
            for (let i = 0; i < sa.length; i++) { if (sa[i] !== sb[i]) return sa[i] - sb[i]; }
            return (a.order_in_section || 0) - (b.order_in_section || 0);
        });
    }

    function addNguyenPrefix(position) {
        if (!position) return position;
        const p = position.trim();
        if (/^nguyên/i.test(p)) return p;
        return `Nguyên ${p}`;
    }

    function assignSeat(code, person) {
        seatMap[code] = {
            name: person.name,
            rank: person.rank || '',
            position: person.position || '',
            unit: person.unit || person.dept || '',
            group: person._group || 'cbcs',
            section: person.section || '',
            cssClass: person._css || 'cbcs'
        };
    }

    const guestNames = new Set(guests.map(g => g.name));
    const assigned = new Set();

    function isTongCucLevel(person) {
        return /tổng cục/i.test(person.position || '') || /tổng cục/i.test(person.unit || '');
    }

    // Helper: left seats (10,9,8,...,1) and right seats (11,12,...,20)
    const leftSeatsOrder = [];
    for (let i = 0; i < SEATS_PER_SIDE; i++) leftSeatsOrder.push(SEATS_PER_SIDE - i);
    const rightSeatsOrder = [];
    for (let i = 0; i < SEATS_PER_SIDE; i++) rightSeatsOrder.push(SEATS_PER_SIDE + 1 + i);

    // ============================================================
    // ROW 1: LEFT = Cục trưởng (seat 10) → Nguyên LĐ Bộ (II)
    //         RIGHT = Bộ trưởng (seat 11) → đ/c Ngọc (12) → LĐ Bộ (I) → Nguyên LĐ Bộ
    // ============================================================

    // Cục trưởng → seat R1-10 (innermost left)
    const cucTruong = cbcs.find(o =>
        o.dept === 'C07' && /^cục trưởng$/i.test((o.position || '').trim())
    );
    if (cucTruong) {
        assignSeat('R1-10', {
            ...cucTruong, unit: cucTruong.dept, section: 'Lãnh đạo C07',
            _css: 'c07', _group: 'c07'
        });
        assigned.add(cucTruong.name);
    }

    // Bộ trưởng → seat R1-11 (innermost right)
    const boTruong = guests.find(g =>
        g.section_num === 'I' && /bộ trưởng/i.test(g.position || '')
    );
    if (boTruong) {
        assignSeat('R1-11', {
            ...boTruong, _css: 'section-1', _group: `guest-${boTruong.priority}`
        });
        assigned.add(boTruong.name);
    }

    // đ/c Nguyễn Duy Ngọc → seat R1-12 (next right after Bộ trưởng)
    const dcNgoc = guests.find(g =>
        g.section_num === 'II' && g.name === 'Nguyễn Duy Ngọc'
    );
    if (dcNgoc) {
        assignSeat('R1-12', {
            ...dcNgoc, _css: 'section-2', _group: `guest-${dcNgoc.priority}`
        });
        assigned.add(dcNgoc.name);
    }

    // Row 1: distribute Lãnh đạo Bộ (Thứ trưởng) between LEFT and RIGHT
    const allLDBo = sortByPriority(
        guests.filter(g => g.section_num === 'I' && !assigned.has(g.name))
    ).map(p => ({ ...p, _css: 'section-1', _group: `guest-${p.priority}` }));

    // Split: first half → LEFT (seats 9,8,...), second half → RIGHT (seats 13,14,...)
    const leftLDBoCount = Math.ceil(allLDBo.length / 2);
    const leftLDBo = allLDBo.slice(0, leftLDBoCount);
    const rightLDBo = allLDBo.slice(leftLDBoCount);

    // Fill Row 1 LEFT: seats 9,8,7,... with Lãnh đạo Bộ first (inner seats)
    let r1LeftIdx = 0;
    for (let i = 1; i < leftSeatsOrder.length; i++) {
        if (r1LeftIdx >= leftLDBo.length) break;
        const sn = leftSeatsOrder[i]; // 9,8,7,...,1
        const code = `R1-${String(sn).padStart(2, '0')}`;
        assignSeat(code, leftLDBo[r1LeftIdx]);
        assigned.add(leftLDBo[r1LeftIdx].name);
        r1LeftIdx++;
    }

    // Fill remaining Row 1 LEFT with nguyên LĐ Bộ (outer seats)
    const nguyenLDBo = sortByPriority(
        guests.filter(g => g.section_num === 'II' && !assigned.has(g.name))
    ).map(p => ({
        ...p, position: addNguyenPrefix(p.position),
        _css: 'section-2', _group: `guest-${p.priority}`
    }));

    let ngIdx = 0;
    for (let i = 1 + r1LeftIdx; i < leftSeatsOrder.length; i++) {
        if (ngIdx >= nguyenLDBo.length) break;
        const sn = leftSeatsOrder[i];
        const code = `R1-${String(sn).padStart(2, '0')}`;
        if (seatMap[code]) continue;
        assignSeat(code, nguyenLDBo[ngIdx]);
        assigned.add(nguyenLDBo[ngIdx].name);
        ngIdx++;
    }

    // Fill Row 1 RIGHT (seats 13,14,...,20) with remaining Lãnh đạo Bộ
    let r1RightIdx = 0;
    for (let i = 2; i < rightSeatsOrder.length; i++) {
        if (r1RightIdx >= rightLDBo.length) break;
        const sn = rightSeatsOrder[i];
        const code = `R1-${String(sn).padStart(2, '0')}`;
        assignSeat(code, rightLDBo[r1RightIdx]);
        assigned.add(rightLDBo[r1RightIdx].name);
        r1RightIdx++;
    }

    // Fill remaining Row 1 RIGHT with nguyên LĐ Bộ overflow
    const nguyenLDBoForR1Right = sortByPriority(
        guests.filter(g => g.section_num === 'II' && !assigned.has(g.name))
    ).map(p => ({
        ...p, position: addNguyenPrefix(p.position),
        _css: 'section-2', _group: `guest-${p.priority}`
    }));
    let ngR1r = 0;
    for (let i = 2 + r1RightIdx; i < rightSeatsOrder.length; i++) {
        if (ngR1r >= nguyenLDBoForR1Right.length) break;
        const sn = rightSeatsOrder[i];
        const code = `R1-${String(sn).padStart(2, '0')}`;
        if (seatMap[code]) continue;
        assignSeat(code, nguyenLDBoForR1Right[ngR1r]);
        assigned.add(nguyenLDBoForR1Right[ngR1r].name);
        ngR1r++;
    }

    // ============================================================
    // ROW 2 LEFT: PCT C07 đương nhiệm → Nguyên LĐC (Tổng cục trước → Cục)
    // ============================================================

    // C07 Phó cục trưởng đương nhiệm
    const pctDuongNhiem = sortByPriority(cbcs.filter(o =>
        o.dept === 'C07' && !assigned.has(o.name) && !/nguyên/i.test(o.position || '')
    )).map(p => ({
        ...p, unit: p.dept, section: 'Lãnh đạo C07', _css: 'c07', _group: 'c07'
    }));

    // Nguyên lãnh đạo cục: Tổng cục trước, Cục sau (từ Section III)
    const nguyenLDTongCuc = sortByPriority(
        guests.filter(g => g.section_num === 'III' && !assigned.has(g.name) && isTongCucLevel(g))
    ).map(p => ({
        ...p, position: addNguyenPrefix(p.position),
        _css: 'section-3', _group: `guest-${p.priority}`
    }));

    const nguyenLDCuc = sortByPriority(
        guests.filter(g => g.section_num === 'III' && !assigned.has(g.name) && !isTongCucLevel(g))
    ).map(p => ({
        ...p, position: addNguyenPrefix(p.position),
        _css: 'section-3', _group: `guest-${p.priority}`
    }));

    // Row 2 LEFT order: Nguyên LĐC (inner/aisle) → PCT C07 (outer/wall)
    // Calculate how many nguyên seats fit on Row 2 LEFT
    const nguyenSlotsR2 = SEATS_PER_SIDE - pctDuongNhiem.length;
    // Prefer guest-only nguyên (not also in cbcs) for Row 2, so Nguyễn Tuấn Anh goes to Row 3
    const cbcsNames = new Set(cbcs.map(c => c.name));
    const nguyenLDCucGuestOnly = nguyenLDCuc.filter(p => !cbcsNames.has(p.name));
    const nguyenLDCucCbcsAlso = nguyenLDCuc.filter(p => cbcsNames.has(p.name));
    const allNguyenForR2 = [...nguyenLDTongCuc, ...nguyenLDCucGuestOnly, ...nguyenLDCucCbcsAlso];
    const nguyenForRow2 = allNguyenForR2.slice(0, nguyenSlotsR2);

    const row2Left = [...nguyenForRow2, ...pctDuongNhiem];

    let r2l = 0;
    for (const sn of leftSeatsOrder) {
        if (r2l >= row2Left.length) break;
        const code = `R2-${String(sn).padStart(2, '0')}`;
        assignSeat(code, row2Left[r2l]);
        assigned.add(row2Left[r2l].name);
        r2l++;
    }

    // ============================================================
    // ROW 2 RIGHT: Nguyên LĐ Bộ (overflow) → đ/c đã từng CT tại C07
    //   Khương & Việt: KHÔNG có chữ "nguyên"
    //   Lê Ngọc Hải: excluded (goes to LEFT pool later)
    // ============================================================

    const row2RightPool = [];

    // Nguyên lãnh đạo Bộ chưa xếp
    sortByPriority(
        guests.filter(g => g.section_num === 'II' && !assigned.has(g.name))
    ).forEach(p => row2RightPool.push({
        ...p, position: addNguyenPrefix(p.position),
        _css: 'section-2', _group: `guest-${p.priority}`
    }));

    // Đ/c đã từng công tác tại C07 (Section V):
    // Khương & Việt giữ nguyên chức vụ (Phó Cục trưởng), Lê Ngọc Hải → bên trái
    sortByPriority(
        guests.filter(g => g.section_num === 'V' && !assigned.has(g.name) && g.name !== 'Lê Ngọc Hải')
    ).forEach(p => {
        row2RightPool.push({
            ...p, _css: 'section-5', _group: `guest-${p.priority}`
        });
    });

    // Fill Row 2 RIGHT with row2RightPool
    let r2r = 0;
    for (const sn of rightSeatsOrder) {
        if (r2r >= row2RightPool.length) break;
        const code = `R2-${String(sn).padStart(2, '0')}`;
        assignSeat(code, row2RightPool[r2r]);
        assigned.add(row2RightPool[r2r].name);
        r2r++;
    }

    // ============================================================
    // Build LEFT and RIGHT pools (for rows 3+)
    // LEFT: Nguyên LĐC → Hưu trí C07 → Lãnh đạo Phòng 376 → Lê Ngọc Hải →
    //        Trưởng phòng C07 (8) → Phó phòng C07 → Trống (CBCS C07)
    // RIGHT: Thư ký → Cục thuộc Bộ → Hiệp hội/UBND/CA phường →
    //         PC07 → Lãnh đạo Phòng C07 → Báo chí → Trống
    // ============================================================

    // --- LEFT POOL ---
    const leftPool = [];

    // 1) Lãnh đạo cục C07 hưu trí (Section III chưa xếp)
    sortByPriority(
        guests.filter(g => g.section_num === 'III' && !assigned.has(g.name))
    ).forEach(p => leftPool.push({
        ...p, position: addNguyenPrefix(p.position),
        _css: 'section-3', _group: `guest-${p.priority}`
    }));

    // 2) Lãnh đạo phòng C07 hưu trí (Section IV) → renamed "Hưu trí C07"
    sortByPriority(
        guests.filter(g => g.section_num === 'IV' && !assigned.has(g.name))
    ).forEach(p => leftPool.push({
        ...p, name: 'Hưu trí C07', rank: '', position: '',
        _css: 'section-4', _group: `guest-${p.priority}`
    }));

    // 3) Lê Ngọc Hải (from Section V) → renamed "Lãnh đạo Phòng 376"
    const leNgocHai = guests.find(g => g.name === 'Lê Ngọc Hải' && !assigned.has(g.name));
    if (leNgocHai) {
        leftPool.push({
            ...leNgocHai, name: 'Lãnh đạo Phòng 376', rank: '', position: '',
            _css: 'section-6', _group: `guest-${leNgocHai.priority}`
        });
    }

    // 4) Diện 376 (Section VI) → renamed "Lãnh đạo Phòng 376"
    const section6Items = sortByPriority(
        guests.filter(g => g.section_num === 'VI' && !assigned.has(g.name))
    ).map(p => ({
        ...p, name: 'Lãnh đạo Phòng 376', rank: '', position: '',
        _css: 'section-6', _group: `guest-${p.priority}`
    }));
    leftPool.push(...section6Items);

    // 5) Trưởng phòng C07 đương nhiệm (8 trưởng phòng)
    const truongPhongList = sortByPriority(cbcs.filter(o =>
        o.dept !== 'C07' && !assigned.has(o.name) && !guestNames.has(o.name) &&
        (o.position === 'TP' || o.position === 'GĐTT' || o.position === 'Viện trưởng' ||
         o.position === 'Chánh TT')
    )).map(p => ({
        ...p, name: 'Trưởng phòng C07', rank: '', position: '',
        unit: p.dept, _css: 'cbcs', _group: 'cbcs'
    }));

    // 6) 1 × "Phó Trưởng phòng C07"
    const phoPhongAll = sortByPriority(cbcs.filter(o =>
        o.dept !== 'C07' && !assigned.has(o.name) && !guestNames.has(o.name) &&
        (o.position === 'PTP' || o.position === 'PGĐTT' || o.position === 'PVT' ||
         o.position === 'Phó CTT')
    ));
    let phoTPItem = null;
    if (phoPhongAll.length > 0) {
        phoTPItem = {
            ...phoPhongAll[0], name: 'Phó Trưởng phòng C07', rank: '', position: '',
            unit: phoPhongAll[0].dept, _css: 'cbcs', _group: 'cbcs'
        };
        assigned.add(phoPhongAll[0].name);
    }

    // 7) Remaining Phó trưởng phòng → "Lãnh đạo Phòng C07"
    const phoPhongList = sortByPriority(cbcs.filter(o =>
        o.dept !== 'C07' && !assigned.has(o.name) && !guestNames.has(o.name) &&
        (o.position === 'PTP' || o.position === 'PGĐTT' || o.position === 'PVT' ||
         o.position === 'Phó CTT')
    )).map(p => ({
        ...p, name: 'Lãnh đạo Phòng C07', rank: '', position: '',
        unit: p.dept, _css: 'cbcs', _group: 'cbcs'
    }));

    // Reorder for Row 9: TP at inner seats (near aisle), Phó TP + remaining 376 at outer
    // Row 3-8 = 6 rows × 10 seats = 60 items from start of leftPool
    const row9StartIdx = 6 * SEATS_PER_SIDE; // = 60
    const itemsBeforeTP = leftPool.length; // III + Hưu trí + 376 items

    if (itemsBeforeTP > row9StartIdx) {
        // Some 376 items spill into Row 9 — pull them out and re-add after TP
        const spillCount = itemsBeforeTP - row9StartIdx;
        const spillItems = leftPool.splice(leftPool.length - spillCount, spillCount);
        // Row 9 order: TP (inner) → Phó TP → spill 376 (outer)
        leftPool.push(...truongPhongList);
        if (phoTPItem) leftPool.push(phoTPItem);
        leftPool.push(...spillItems);
    } else {
        // No spill — just add TP then Phó TP
        leftPool.push(...truongPhongList);
        if (phoTPItem) leftPool.push(phoTPItem);
    }
    leftPool.push(...phoPhongList);

    // --- RIGHT POOL (rows 3-10) ---
    const rightPool = [];

    // Calculate remaining Row 2 RIGHT seats to fill
    const row2RightRemaining = SEATS_PER_SIDE - row2RightPool.length;

    // 1) Cục nghiệp vụ (Section VII, trừ thư ký) → renamed "Cục thuộc Bộ"
    const cucThuocBoAll = sortByPriority(
        guests.filter(g =>
            g.section_num === 'VII' && !assigned.has(g.name) &&
            !/thư ký/i.test(g.name)
        )
    ).map(p => ({
        ...p, name: 'Cục thuộc Bộ', rank: '', position: '',
        _css: 'section-7', _group: `guest-${p.priority}`
    }));

    // First batch fills remaining Row 2 RIGHT seats
    const cucThuocBoR2 = cucThuocBoAll.slice(0, row2RightRemaining);
    const cucThuocBoR3plus = cucThuocBoAll.slice(row2RightRemaining);
    rightPool.push(...cucThuocBoR2);

    // 2) Thư ký lãnh đạo Bộ (TK7) — goes to Row 3 RIGHT seat 11 (below Võ Thái Hòa)
    guests.filter(g =>
        g.section_num === 'VII' && !assigned.has(g.name) &&
        /thư ký/i.test(g.name)
    ).forEach(p => rightPool.push({
        ...p, _css: 'section-7', _group: `guest-${p.priority}`
    }));

    // Remaining Cục thuộc Bộ continues after TK7
    rightPool.push(...cucThuocBoR3plus);

    // 3) Hiệp hội PCCC, UBND phường Đại Mỗ, CA phường Đại Mỗ
    const extraSeats = [
        { name: 'Hiệp hội PCCC', rank: '', position: '', unit: '', _css: 'section-9', _group: 'guest-9', section: '' },
        { name: 'UBND phường Đại Mỗ', rank: '', position: '', unit: '', _css: 'section-10', _group: 'guest-10', section: '' },
        { name: 'CA phường Đại Mỗ', rank: '', position: '', unit: '', _css: 'section-10', _group: 'guest-10', section: '' }
    ];
    extraSeats.forEach(p => rightPool.push(p));

    // 4) PC07 địa phương (Section VIII) → renamed "PC07"
    sortByPriority(
        guests.filter(g => g.section_num === 'VIII' && !assigned.has(g.name))
    ).forEach(p => rightPool.push({
        ...p, name: 'PC07', rank: '', position: '',
        _css: 'section-8', _group: `guest-${p.priority}`
    }));

    // 5) Lãnh đạo Phòng C07 - split between left and right for balance
    // Left side fills rows 3-10 only; Row 11 LEFT = CBCS C07
    let leftCapacity = 0;
    for (const sn of leftSeatsOrder) {
        const code = `R2-${String(sn).padStart(2, '0')}`;
        if (!seatMap[code]) leftCapacity++;
    }
    leftCapacity += (TOTAL_ROWS - 3) * SEATS_PER_SIDE; // rows 3-10 only (8 rows)

    const leftFit = leftPool.slice(0, leftCapacity);
    const leftOverflow = leftPool.slice(leftCapacity);
    // Overflow from left → right pool (LĐ Phòng C07 balance)
    leftOverflow.forEach(p => rightPool.push(p));

    // --- RIGHT POOL (Row 11 only) - Báo chí truyền thông ---
    // These are separated and will be placed ONLY on Row 11 RIGHT
    const mediaPool = [];
    sortByPriority(
        guests.filter(g =>
            ['IX', 'X', 'XI'].includes(g.section_num) && !assigned.has(g.name)
        )
    ).forEach(p => mediaPool.push({
        ...p, _css: cssMap[p.section_num] || 'section-11', _group: `guest-${p.priority}`
    }));

    // ============================================================
    // Fill Row 2 remaining empty seats, then rows 3+ compactly
    // ============================================================

    let leftIdx = 0;
    let rightIdx = 0;

    // Fill remaining Row 2 LEFT empty seats
    for (const sn of leftSeatsOrder) {
        const code = `R2-${String(sn).padStart(2, '0')}`;
        if (seatMap[code]) continue;
        if (leftIdx >= leftFit.length) break;
        const person = leftFit[leftIdx];
        assignSeat(code, person);
        if (person.name) assigned.add(person.name);
        leftIdx++;
    }

    // Fill remaining Row 2 RIGHT empty seats
    for (const sn of rightSeatsOrder) {
        const code = `R2-${String(sn).padStart(2, '0')}`;
        if (seatMap[code]) continue;
        if (rightIdx >= rightPool.length) break;
        const person = rightPool[rightIdx];
        assignSeat(code, person);
        if (person.name) assigned.add(person.name);
        rightIdx++;
    }

    // Fill rows 3-10 with left and right pools
    for (let rowNum = 3; rowNum <= TOTAL_ROWS - 1; rowNum++) {
        for (const sn of leftSeatsOrder) {
            if (leftIdx >= leftFit.length) break;
            const code = `R${rowNum}-${String(sn).padStart(2, '0')}`;
            const person = leftFit[leftIdx];
            assignSeat(code, person);
            if (person.name) assigned.add(person.name);
            leftIdx++;
        }

        for (const sn of rightSeatsOrder) {
            if (rightIdx >= rightPool.length) break;
            const code = `R${rowNum}-${String(sn).padStart(2, '0')}`;
            const person = rightPool[rightIdx];
            assignSeat(code, person);
            if (person.name) assigned.add(person.name);
            rightIdx++;
        }
    }

    // ============================================================
    // Row 11: LEFT = CBCS C07, RIGHT = Báo chí truyền thông + CBCS C07
    // ============================================================

    // Row 11 LEFT: all CBCS C07
    for (const sn of leftSeatsOrder) {
        const code = `R${TOTAL_ROWS}-${String(sn).padStart(2, '0')}`;
        assignSeat(code, {
            name: 'CBCS C07', rank: '', position: '', unit: 'C07',
            _css: 'cbcs', _group: 'cbcs', section: ''
        });
    }

    // Row 11 RIGHT: Báo chí truyền thông first, then CBCS C07
    let mediaIdx = 0;
    for (const sn of rightSeatsOrder) {
        const code = `R${TOTAL_ROWS}-${String(sn).padStart(2, '0')}`;
        if (mediaIdx < mediaPool.length) {
            assignSeat(code, mediaPool[mediaIdx]);
            mediaIdx++;
        } else {
            assignSeat(code, {
                name: 'CBCS C07', rank: '', position: '', unit: 'C07',
                _css: 'cbcs', _group: 'cbcs', section: ''
            });
        }
    }

    // ============================================================
    // Fill ALL remaining empty seats with "CBCS C07"
    // ============================================================
    for (let rowNum = 1; rowNum <= TOTAL_ROWS; rowNum++) {
        for (let s = 1; s <= SEATS_PER_ROW; s++) {
            const code = `R${rowNum}-${String(s).padStart(2, '0')}`;
            if (!seatMap[code]) {
                assignSeat(code, {
                    name: 'CBCS C07', rank: '', position: '', unit: 'C07',
                    _css: 'cbcs', _group: 'cbcs', section: ''
                });
            }
        }
    }

    if (leftIdx < leftFit.length) {
        console.warn(`${leftFit.length - leftIdx} people unassigned on LEFT!`);
    }
    if (rightIdx < rightPool.length) {
        console.warn(`${rightPool.length - rightIdx} people unassigned on RIGHT!`);
    }
}

/**
 * Center-out seating order for a row.
 * Most important seats are near center aisle.
 * Left: seat 10 (closest to aisle) → seat 1 (furthest)
 * Right: seat 11 (closest) → seat 20 (furthest)
 * Pattern: 10, 11, 9, 12, 8, 13, 7, 14, 6, 15, 5, 16, 4, 17, 3, 18, 2, 19, 1, 20
 */
function generateCenterOutOrder(seatsPerSide) {
    const order = [];
    for (let i = 0; i < seatsPerSide; i++) {
        order.push(seatsPerSide - i);           // Left: 10, 9, 8, ...
        order.push(seatsPerSide + 1 + i);       // Right: 11, 12, 13, ...
    }
    return order;
}

function applySeatMap() {
    document.querySelectorAll('.seat').forEach(el => {
        const code = el.dataset.code;
        if (!code) return;

        const person = seatMap[code];
        if (person) {
            el.className = `seat ${person.cssClass}`;
            el.querySelector('.seat-name').textContent = person.name;
            el.querySelector('.seat-rank').textContent = person.rank || '';
            el.querySelector('.seat-position').textContent = person.position || '';

            const tooltip = [person.name, person.rank, person.position, person.unit]
                .filter(Boolean).join(' • ');
            el.dataset.tooltip = tooltip;
        } else {
            el.className = 'seat empty-seat';
            el.querySelector('.seat-name').textContent = 'Trống';
            el.querySelector('.seat-rank').textContent = '';
            el.querySelector('.seat-position').textContent = '';
            el.dataset.tooltip = `Ghế trống (${code})`;
        }

        // Seat code visibility
        const codeEl = el.querySelector('.seat-code');
        if (codeEl) {
            codeEl.textContent = code;
            codeEl.className = `seat-code${showSeatCodes ? '' : ' hidden'}`;
        }
    });
}

// ============================================================
// SEAT INTERACTIONS
// ============================================================

function onSeatClick(code, e) {
    if (swapMode) {
        completeSwap(code);
        return;
    }
    openEditModal(code);
}

function onSeatRightClick(code, e) {
    e.preventDefault();
    showContextMenu(code, e.clientX, e.clientY);
}

function showContextMenu(code, x, y) {
    removeContextMenu();

    const menu = document.createElement('div');
    menu.className = 'context-menu';
    menu.style.left = `${x}px`;
    menu.style.top = `${y}px`;

    const items = [
        { icon: '✏️', label: 'Chỉnh sửa', action: () => openEditModal(code) },
        { icon: '🔄', label: 'Hoán đổi vị trí', action: () => startSwap(code) },
        { separator: true },
        { icon: '🗑️', label: 'Xóa (để trống)', action: () => clearSeatByCode(code) },
    ];

    items.forEach(item => {
        if (item.separator) {
            const sep = document.createElement('div');
            sep.className = 'context-menu-separator';
            menu.appendChild(sep);
        } else {
            const btn = document.createElement('button');
            btn.className = 'context-menu-item';
            btn.innerHTML = `<span>${item.icon}</span> ${item.label}`;
            btn.addEventListener('click', () => {
                removeContextMenu();
                item.action();
            });
            menu.appendChild(btn);
        }
    });

    document.body.appendChild(menu);
    contextMenu = menu;

    const rect = menu.getBoundingClientRect();
    if (rect.right > window.innerWidth) menu.style.left = `${x - rect.width}px`;
    if (rect.bottom > window.innerHeight) menu.style.top = `${y - rect.height}px`;

    setTimeout(() => {
        document.addEventListener('click', removeContextMenu, { once: true });
    }, 10);
}

function removeContextMenu() {
    if (contextMenu) {
        contextMenu.remove();
        contextMenu = null;
    }
}

// ============================================================
// EDIT MODAL
// ============================================================

function openEditModal(code) {
    const modal = document.getElementById('editModal');
    const person = seatMap[code] || {};

    document.getElementById('editSeatCode').value = code;
    document.getElementById('editName').value = person.name || '';
    document.getElementById('editRank').value = person.rank || '';
    document.getElementById('editPosition').value = person.position || '';
    document.getElementById('editUnit').value = person.unit || '';
    document.getElementById('editGroup').value = person.group || 'cbcs';

    document.getElementById('modalTitle').textContent = `Chỉnh sửa ghế ${code}`;
    modal.style.display = 'flex';
    document.getElementById('editName').focus();
}

function closeModal() {
    document.getElementById('editModal').style.display = 'none';
}

function saveSeatEdit() {
    const code = document.getElementById('editSeatCode').value;
    const name = document.getElementById('editName').value.trim();
    const rank = document.getElementById('editRank').value.trim();
    const position = document.getElementById('editPosition').value.trim();
    const unit = document.getElementById('editUnit').value.trim();
    const group = document.getElementById('editGroup').value;

    pushHistory();

    if (!name) {
        delete seatMap[code];
    } else {
        const cssClass = groupToCss(group);
        seatMap[code] = { name, rank, position, unit, group, section: '', cssClass };
    }

    applySeatMap();
    updateStats();
    closeModal();
    showToast(`Đã cập nhật ghế ${code}`, 'success');
}

function clearSeat() {
    const code = document.getElementById('editSeatCode').value;
    pushHistory();
    delete seatMap[code];
    applySeatMap();
    updateStats();
    closeModal();
    showToast(`Đã xóa ghế ${code}`, 'success');
}

function clearSeatByCode(code) {
    pushHistory();
    delete seatMap[code];
    applySeatMap();
    updateStats();
    showToast(`Đã xóa ghế ${code}`, 'success');
}

function groupToCss(group) {
    const map = {
        'guest-1': 'section-1',
        'guest-2': 'section-2',
        'guest-3': 'section-3',
        'guest-4': 'section-4',
        'guest-5': 'section-5',
        'guest-6': 'section-6',
        'guest-7': 'section-7',
        'guest-8': 'section-8',
        'guest-9': 'section-9',
        'c07': 'c07',
        'cbcs': 'cbcs'
    };
    return map[group] || 'cbcs';
}

// ============================================================
// SWAP MODE
// ============================================================

function startSwap(code) {
    swapMode = true;
    swapSourceCode = code;
    document.getElementById('swapOverlay').style.display = 'block';

    const srcEl = document.getElementById(`seat-${code}`);
    if (srcEl) srcEl.classList.add('swap-source');
}

function completeSwap(targetCode) {
    if (targetCode === swapSourceCode) {
        cancelSwap();
        return;
    }

    pushHistory();

    const srcData = seatMap[swapSourceCode] || null;
    const tgtData = seatMap[targetCode] || null;

    if (srcData) seatMap[targetCode] = { ...srcData };
    else delete seatMap[targetCode];

    if (tgtData) seatMap[swapSourceCode] = { ...tgtData };
    else delete seatMap[swapSourceCode];

    applySeatMap();
    updateStats();
    cancelSwap();
    showToast('Đã hoán đổi vị trí', 'success');
}

function cancelSwap() {
    swapMode = false;
    document.getElementById('swapOverlay').style.display = 'none';
    if (swapSourceCode) {
        const srcEl = document.getElementById(`seat-${swapSourceCode}`);
        if (srcEl) srcEl.classList.remove('swap-source');
    }
    swapSourceCode = null;
}

// ============================================================
// SEARCH
// ============================================================

function searchPerson(query) {
    const clearBtn = document.getElementById('searchClear');
    const countEl = document.getElementById('searchCount');
    const chart = document.getElementById('chartContainer');

    clearBtn.style.display = query ? 'block' : 'none';

    // Clear previous highlights
    document.querySelectorAll('.seat.highlighted').forEach(el => el.classList.remove('highlighted'));
    chart.classList.remove('search-active');
    countEl.style.display = 'none';

    if (!query || query.length < 2) return;

    const q = query.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');

    let found = 0;
    for (const [code, person] of Object.entries(seatMap)) {
        const searchStr = [person.name, person.rank, person.position, person.unit]
            .join(' ').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');

        if (searchStr.includes(q)) {
            const el = document.getElementById(`seat-${code}`);
            if (el) {
                el.classList.add('highlighted');
                if (found === 0) {
                    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
                }
                found++;
            }
        }
    }

    // Activate search dimming mode
    if (found > 0) {
        chart.classList.add('search-active');
        countEl.textContent = `${found} kết quả`;
        countEl.style.display = 'inline';
    } else if (query.length >= 2) {
        countEl.textContent = 'Không tìm thấy';
        countEl.style.display = 'inline';
    }
}

function clearSearch() {
    document.getElementById('searchInput').value = '';
    document.getElementById('searchClear').style.display = 'none';
    document.getElementById('searchCount').style.display = 'none';
    document.getElementById('chartContainer').classList.remove('search-active');
    document.querySelectorAll('.seat.highlighted').forEach(el => el.classList.remove('highlighted'));
}

// ============================================================
// SAVE / UNDO
// ============================================================

function pushHistory() {
    history.push(JSON.stringify(seatMap));
    if (history.length > 50) history.shift();
}

function undoChange() {
    if (history.length === 0) {
        showToast('Không có thao tác để hoàn tác', 'info');
        return;
    }
    seatMap = JSON.parse(history.pop());
    applySeatMap();
    updateStats();
    showToast('Đã hoàn tác', 'success');
}

function saveChanges() {
    localStorage.setItem('seatingArrangement_65_v3', JSON.stringify(seatMap));
    showToast('Đã lưu sơ đồ!', 'success');
}

// ============================================================
// EXPORT
// ============================================================

function exportExcel() {
    const BOM = '\uFEFF';
    const rows = [['STT', 'Mã ghế', 'Dãy', 'Vị trí', 'Bàn', 'Họ và tên', 'Cấp bậc', 'Chức vụ', 'Đơn vị', 'Nhóm']];

    const allCodes = [];
    for (let r = 1; r <= TOTAL_ROWS; r++) {
        for (let s = 1; s <= SEATS_PER_ROW; s++) {
            allCodes.push(`R${r}-${String(s).padStart(2, '0')}`);
        }
    }

    let stt = 0;
    allCodes.forEach(code => {
        const person = seatMap[code];
        if (!person) return;

        stt++;
        const parts = code.substring(1).split('-');
        const rowNum = parseInt(parts[0]);
        const seatNum = parseInt(parts[1]);
        const hasTable = rowNum <= TABLE_ROWS ? 'Có' : 'Không';
        const side = seatNum <= SEATS_PER_SIDE ? 'Trái' : 'Phải';

        const groupLabels = {
            'guest-1': 'I. Lãnh đạo Bộ',
            'guest-2': 'II. Nguyên lãnh đạo Bộ',
            'guest-3': 'III. Lãnh đạo Tổng Cục/Cục',
            'guest-4': 'IV. Lãnh đạo Phòng C07 (nghỉ hưu)',
            'guest-5': 'V. Nguyên lãnh đạo C07',
            'guest-6': 'VI. KH376',
            'guest-7': 'VII. Đơn vị trực thuộc Bộ',
            'guest-8': 'VIII. Công an địa phương',
            'guest-9': 'IX. Hiệp hội PCCC',
            'guest-10': 'X. Địa phương Đại Mỗ',
            'guest-11': 'XI. Báo chí',
            'c07': 'Lãnh đạo C07',
            'cbcs': 'Trưởng/Phó phòng C07'
        };

        rows.push([
            stt,
            code,
            `Dãy ${rowNum}`,
            `${side} - Ghế ${seatNum}`,
            hasTable,
            person.name,
            person.rank,
            person.position,
            person.unit,
            groupLabels[person.group] || person.group
        ]);
    });

    const csv = BOM + rows.map(r => r.map(c => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\n');

    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'So_do_cho_ngoi_65_nam.csv';
    a.click();
    URL.revokeObjectURL(url);
    showToast(`Đã xuất danh sách ${stt} người ra CSV`, 'success');
}

function printChart() {
    window.print();
}

// ============================================================
// ZOOM
// ============================================================

function zoomIn() {
    currentZoom = Math.min(currentZoom + 10, 150);
    applyZoom();
}

function zoomOut() {
    currentZoom = Math.max(currentZoom - 10, 50);
    applyZoom();
}

function zoomReset() {
    currentZoom = 100;
    applyZoom();
}

function applyZoom() {
    document.getElementById('chartContainer').style.transform = `scale(${currentZoom / 100})`;
    document.getElementById('zoomLevel').textContent = `${currentZoom}%`;
}

// ============================================================
// TOGGLE CONTROLS
// ============================================================

function toggleSeatCodes() {
    showSeatCodes = !showSeatCodes;
    document.querySelectorAll('.seat-code').forEach(el => {
        el.className = `seat-code${showSeatCodes ? '' : ' hidden'}`;
    });
    showToast(showSeatCodes ? 'Hiện mã ghế' : 'Ẩn mã ghế', 'info');
}

function toggleLegend() {
    document.getElementById('legendPanel').classList.toggle('active');
}

// ============================================================
// STATS
// ============================================================

function updateStats() {
    const filled = Object.keys(seatMap).length;
    const empty = TOTAL_SEATS - filled;

    const guestCount = Object.values(seatMap).filter(p =>
        p.group && p.group.startsWith('guest')).length;
    const leaderCount = Object.values(seatMap).filter(p =>
        p.group === 'c07' || p.group === 'cbcs').length;

    document.getElementById('headerStats').innerHTML = `
        <div class="stat-item">
            <div class="stat-value">${filled}</div>
            <div class="stat-label">Có chỗ</div>
        </div>
        <div class="stat-item">
            <div class="stat-value">${guestCount}</div>
            <div class="stat-label">Khách mời</div>
        </div>
        <div class="stat-item">
            <div class="stat-value">${leaderCount}</div>
            <div class="stat-label">LĐ & TP/PTP</div>
        </div>
        <div class="stat-item">
            <div class="stat-value">${empty}</div>
            <div class="stat-label">Ghế trống</div>
        </div>
    `;
}

// ============================================================
// UTILITIES
// ============================================================

function showToast(message, type = 'info') {
    const container = document.getElementById('toastContainer');
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.textContent = message;
    container.appendChild(toast);
    setTimeout(() => toast.remove(), 3000);
}

function setupKeyboardShortcuts() {
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            if (swapMode) cancelSwap();
            else closeModal();
            removeContextMenu();
        }
        if (e.ctrlKey && e.key === 's') {
            e.preventDefault();
            saveChanges();
        }
        if (e.ctrlKey && e.key === 'z') {
            e.preventDefault();
            undoChange();
        }
        if (e.ctrlKey && e.key === 'f') {
            e.preventDefault();
            document.getElementById('searchInput').focus();
        }
    });
}

function setupContextMenu() {
    window.addEventListener('scroll', removeContextMenu);
}
