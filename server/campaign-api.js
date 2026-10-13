import express from 'express';
import { read, utils } from 'xlsx';
import {
    db, audit, getVolunteerBalance, campaignWeekStart, getAllCampaignSettings, setCampaignSettings, campaignGeoLeaves,
    findOrCreateVolunteer
} from './db.js';

// מוצאת את שם העמודה המתאים לפי מילות מפתח חלקיות בכותרת (לא תלוי בניסוח מדויק)
function findCol(row, keywords) {
    const key = Object.keys(row).find((k) => keywords.some((w) => k.trim().includes(w)));
    return key ? row[key] : undefined;
}

// הופכת קובץ אקסל/CSV בבסיס 64 לרשימת שורות (מערך אובייקטים לפי כותרות העמודה הראשונה)
function parseSpreadsheet(base64) {
    const buf = Buffer.from(base64, 'base64');
    const wb = read(buf, { type: 'buffer' });
    const sheet = wb.Sheets[wb.SheetNames[0]];
    return utils.sheet_to_json(sheet, { defval: '' });
}

export function campaignApiRouter({ mustLogin, mustManager, events }) {
    const router = express.Router();

    router.get('/dashboard', mustLogin, (req, res) => {
        const ws = campaignWeekStart();
        const volunteers = db.prepare('SELECT * FROM campaign_volunteers ORDER BY created_at DESC').all()
            .map((v) => ({ ...v, balance: getVolunteerBalance(v.id) }));

        const pending = db.prepare(`
            SELECT pt.*, v.phone, v.name FROM campaign_point_transactions pt
            JOIN campaign_volunteers v ON v.id = pt.volunteer_id
            WHERE pt.status = 'pending' ORDER BY pt.created_at ASC
        `).all();

        const recentTxns = db.prepare(`
            SELECT pt.*, v.phone, v.name FROM campaign_point_transactions pt
            JOIN campaign_volunteers v ON v.id = pt.volunteer_id
            ORDER BY pt.created_at DESC LIMIT 30
        `).all();

        const goals = db.prepare(`
            SELECT wg.*, v.phone, v.name FROM campaign_weekly_goals wg
            JOIN campaign_volunteers v ON v.id = wg.volunteer_id
            WHERE wg.week_start = ?
        `).all(ws);

        const prizes = db.prepare('SELECT * FROM campaign_prizes ORDER BY code ASC').all();
        const hubs = db.prepare('SELECT * FROM campaign_hubs ORDER BY name ASC').all();
        const hubLogs = db.prepare(`
            SELECT hl.*, h.name AS hub_name FROM campaign_hub_logs hl
            JOIN campaign_hubs h ON h.id = hl.hub_id
            ORDER BY hl.created_at DESC LIMIT 30
        `).all();
        const settings = getAllCampaignSettings();

        const conversionPercent = parseFloat(settings.campaign_product_conversion_percent);
        const pendingWithSuggestion = pending.map((p) => ({
            ...p,
            suggested_points: (p.type === 'product' && p.value_nis && conversionPercent)
                ? Math.round(p.value_nis * conversionPercent / 100)
                : null
        }));

        res.json({ volunteers, pending: pendingWithSuggestion, recentTxns, goals, prizes, hubs, hubLogs, weekStart: ws, settings });
    });

    // יומן פעולות הקמפיין — מי עשה מה ומתי (אדמין + מתנדבות דרך הטלפון)
    router.get('/activity', mustLogin, (req, res) => {
        const rows = db.prepare(`
            SELECT user_name, action, entity, entity_id, before_state, after_state, at
            FROM audit_log WHERE entity LIKE 'campaign_%' ORDER BY id DESC LIMIT 200
        `).all();
        res.json(rows);
    });

    // הוספת מתנדבת ידנית — ממסך הדשבורד הרגיל, לא רק דרך ניהול/אקסל
    router.post('/volunteers', mustLogin, (req, res) => {
        const phone = String(req.body?.phone ?? '').replace(/\D/g, '');
        const name = String(req.body?.name ?? '').trim();
        if (!phone) return res.status(400).json({ error: 'יש להזין מספר טלפון' });
        let id;
        try {
            const r = db.prepare("INSERT INTO campaign_volunteers (phone, name, identified, created_at) VALUES (?, ?, ?, datetime('now','localtime'))")
                .run(phone, name || null, name ? 1 : 0);
            id = r.lastInsertRowid;
        } catch {
            return res.status(400).json({ error: 'מתנדבת עם טלפון זה כבר קיימת' });
        }
        audit(req.user.name, 'campaign.volunteer.create', 'campaign_volunteers', id, null, { phone, name: name || null });
        events?.emit('campaign.update');
        res.json({ ok: true, id });
    });

    router.get('/geo-leaves', mustLogin, (req, res) => {
        res.json(campaignGeoLeaves());
    });

    router.put('/settings', mustLogin, mustManager, (req, res) => {
        setCampaignSettings(req.body || {});
        // לא לרשום את הלוגו (data URL ענק) ליומן הפעולות — רק שהוא השתנה
        const logged = { ...(req.body || {}) };
        if (logged.campaign_brand_logo) logged.campaign_brand_logo = '(עודכן לוגו)';
        audit(req.user.name, 'campaign.settings.update', 'campaign_settings', null, null, logged);
        events?.emit('campaign.update');
        res.json({ ok: true });
    });

    router.post('/approve/:id', mustLogin, mustManager, (req, res) => {
        const { points } = req.body;
        const pts = parseInt(points, 10);
        if (!Number.isFinite(pts) || pts < 0) return res.status(400).json({ error: 'יש להזין מספר נקודות תקין' });
        const txn = db.prepare("SELECT * FROM campaign_point_transactions WHERE id = ? AND status = 'pending'").get(req.params.id);
        if (!txn) return res.status(404).json({ error: 'הדיווח לא נמצא או שכבר טופל' });
        db.prepare("UPDATE campaign_point_transactions SET status = 'approved', points = ?, approved_at = datetime('now','localtime') WHERE id = ?")
            .run(pts, txn.id);
        const vol = db.prepare('SELECT phone, name FROM campaign_volunteers WHERE id = ?').get(txn.volunteer_id);
        audit(req.user.name, 'campaign.points.approve', 'campaign_point_transactions', txn.id,
            { status: 'pending', value_nis: txn.value_nis }, { status: 'approved', points: pts, volunteer: vol?.name || vol?.phone });
        events?.emit('campaign.update');
        res.json({ ok: true });
    });

    router.post('/reject/:id', mustLogin, mustManager, (req, res) => {
        const txn = db.prepare("SELECT * FROM campaign_point_transactions WHERE id = ? AND status = 'pending'").get(req.params.id);
        if (!txn) return res.status(404).json({ error: 'הדיווח לא נמצא או שכבר טופל' });
        db.prepare("UPDATE campaign_point_transactions SET status = 'rejected', points = 0, approved_at = datetime('now','localtime') WHERE id = ?")
            .run(txn.id);
        const vol = db.prepare('SELECT phone, name FROM campaign_volunteers WHERE id = ?').get(txn.volunteer_id);
        audit(req.user.name, 'campaign.points.reject', 'campaign_point_transactions', txn.id,
            { status: 'pending' }, { status: 'rejected', volunteer: vol?.name || vol?.phone });
        events?.emit('campaign.update');
        res.json({ ok: true });
    });

    router.put('/volunteers/:id', mustLogin, mustManager, (req, res) => {
        const { name } = req.body;
        if (!name || !name.trim()) return res.status(400).json({ error: 'יש להזין שם' });
        const before = db.prepare('SELECT phone, name FROM campaign_volunteers WHERE id = ?').get(req.params.id);
        db.prepare('UPDATE campaign_volunteers SET name = ?, identified = 1 WHERE id = ?').run(name.trim(), req.params.id);
        audit(req.user.name, 'campaign.volunteer.identify', 'campaign_volunteers', req.params.id,
            { name: before?.name, phone: before?.phone }, { name: name.trim() });
        events?.emit('campaign.update');
        res.json({ ok: true });
    });

    // עדכון נקודות ידני למתנדבת — למקרים שלא עברו דרך הטלפון (למשל תיקון, בונוס מיוחד)
    router.post('/volunteers/:id/points', mustLogin, mustManager, (req, res) => {
        const pts = parseInt(req.body?.points, 10);
        if (!Number.isFinite(pts) || pts === 0) return res.status(400).json({ error: 'יש להזין מספר נקודות תקין, לא אפס' });
        const vol = db.prepare('SELECT * FROM campaign_volunteers WHERE id = ?').get(req.params.id);
        if (!vol) return res.status(404).json({ error: 'מתנדבת לא נמצאה' });
        db.prepare(`INSERT INTO campaign_point_transactions (volunteer_id, type, points, status, created_at, approved_at)
                    VALUES (?, 'manual', ?, 'approved', datetime('now','localtime'), datetime('now','localtime'))`).run(vol.id, pts);
        audit(req.user.name, 'campaign.points.manual_adjust', 'campaign_point_transactions', vol.id,
            null, { volunteer: vol.name || vol.phone, points: pts });
        events?.emit('campaign.update');
        res.json({ ok: true });
    });

    // ייבוא רשימת מתנדבות מאקסל — עמודות טלפון + שם (לא תלוי בניסוח מדויק של הכותרת)
    router.post('/import/volunteers', mustLogin, mustManager, (req, res) => {
        let rows;
        try { rows = parseSpreadsheet(req.body?.data || ''); }
        catch { return res.status(400).json({ error: 'לא ניתן לקרוא את הקובץ — יש להעלות אקסל (xlsx/xls/csv) תקין' }); }

        let added = 0, updated = 0, skipped = 0;
        for (const row of rows) {
            const rawPhone = findCol(row, ['טלפון', 'נייד', 'פלאפון']);
            const name = String(findCol(row, ['שם']) ?? '').trim();
            const phone = String(rawPhone ?? '').replace(/\D/g, '');
            if (!phone) { skipped++; continue; }
            const existing = db.prepare('SELECT id, name FROM campaign_volunteers WHERE phone = ?').get(phone);
            if (existing) {
                if (name && !existing.name) {
                    db.prepare('UPDATE campaign_volunteers SET name = ?, identified = 1 WHERE id = ?').run(name, existing.id);
                    updated++;
                } else skipped++;
            } else {
                const v = findOrCreateVolunteer(phone);
                if (name) db.prepare('UPDATE campaign_volunteers SET name = ?, identified = 1 WHERE id = ?').run(name, v.id);
                added++;
            }
        }
        audit(req.user.name, 'campaign.import.volunteers', 'campaign_volunteers', null, null, { added, updated, skipped, total: rows.length });
        events?.emit('campaign.update');
        res.json({ added, updated, skipped, total: rows.length });
    });

    // ייבוא דיווחי גיוס מוצרים מרכזת הגיוס — עמודות טלפון (של השומרת), שווי/שם עסק, ואופציונלית נקודות מפורש.
    // כל שורה הופכת מיידית לנקודות מאושרות (לא ממתינות) — האקסל הוא כבר "המקור האמין" לפי תוכנית העבודה.
    router.post('/import/recruitment', mustLogin, mustManager, (req, res) => {
        let rows;
        try { rows = parseSpreadsheet(req.body?.data || ''); }
        catch { return res.status(400).json({ error: 'לא ניתן לקרוא את הקובץ — יש להעלות אקסל (xlsx/xls/csv) תקין' }); }

        const conversionPercent = parseFloat(getAllCampaignSettings().campaign_product_conversion_percent);
        let added = 0, skipped = 0;
        const skippedReasons = [];
        rows.forEach((row, idx) => {
            const rawPhone = findCol(row, ['טלפון', 'נייד', 'פלאפון']);
            const phone = String(rawPhone ?? '').replace(/\D/g, '');
            const valueNis = parseInt(findCol(row, ['שווי']), 10) || null;
            const explicitPoints = parseInt(findCol(row, ['נקוד']), 10);
            const business = String(findCol(row, ['עסק', 'הערה', 'תיאור']) ?? '').trim();

            if (!phone) { skipped++; skippedReasons.push(`שורה ${idx + 2}: אין מספר טלפון`); return; }
            let points = Number.isFinite(explicitPoints) ? explicitPoints : null;
            if (points === null && valueNis && conversionPercent) points = Math.round(valueNis * conversionPercent / 100);
            if (points === null) { skipped++; skippedReasons.push(`שורה ${idx + 2}: אין נקודות ואין שווי+אחוז המרה מוגדר`); return; }

            const vol = findOrCreateVolunteer(phone);
            db.prepare(`INSERT INTO campaign_point_transactions (volunteer_id, type, points, status, value_nis, note, created_at, approved_at)
                        VALUES (?, 'product', ?, 'approved', ?, ?, datetime('now','localtime'), datetime('now','localtime'))`)
                .run(vol.id, points, valueNis, business || null);
            added++;
        });
        audit(req.user.name, 'campaign.import.recruitment', 'campaign_point_transactions', null, null,
            { added, skipped, total: rows.length });
        events?.emit('campaign.update');
        res.json({ added, skipped, total: rows.length, skippedReasons: skippedReasons.slice(0, 10) });
    });

    // ייבוא קטלוג מתנות מאקסל — עמודות קוד, שם, שווי, נקודות. נכנסות לא-פעיל כברירת מחדל לבדיקה
    router.post('/import/prizes', mustLogin, mustManager, (req, res) => {
        let rows;
        try { rows = parseSpreadsheet(req.body?.data || ''); }
        catch { return res.status(400).json({ error: 'לא ניתן לקרוא את הקובץ — יש להעלות אקסל (xlsx/xls/csv) תקין' }); }

        let added = 0, updated = 0, skipped = 0;
        for (const row of rows) {
            const code = parseInt(findCol(row, ['קוד']), 10);
            const name = String(findCol(row, ['שם']) ?? '').trim();
            const valueNis = parseInt(findCol(row, ['שווי']), 10) || null;
            const pointsCost = parseInt(findCol(row, ['נקוד']), 10) || 0;
            if (!Number.isFinite(code) || !name) { skipped++; continue; }
            const existing = db.prepare('SELECT id FROM campaign_prizes WHERE code = ?').get(code);
            if (existing) {
                db.prepare('UPDATE campaign_prizes SET name = ?, value_nis = ?, points_cost = ? WHERE id = ?')
                    .run(name, valueNis, pointsCost, existing.id);
                updated++;
            } else {
                db.prepare("INSERT INTO campaign_prizes (code, name, value_nis, points_cost, active, created_at) VALUES (?, ?, ?, ?, 0, datetime('now','localtime'))")
                    .run(code, name, valueNis, pointsCost);
                added++;
            }
        }
        audit(req.user.name, 'campaign.import.prizes', 'campaign_prizes', null, null, { added, updated, skipped, total: rows.length });
        events?.emit('campaign.update');
        res.json({ added, updated, skipped, total: rows.length });
    });

    router.post('/prizes', mustLogin, mustManager, (req, res) => {
        const { code, name, value_nis, points_cost } = req.body;
        const c = parseInt(code, 10);
        if (!Number.isFinite(c) || !name || !name.trim()) return res.status(400).json({ error: 'יש להזין קוד ושם תקינים' });
        let id;
        try {
            const r = db.prepare("INSERT INTO campaign_prizes (code, name, value_nis, points_cost, created_at) VALUES (?, ?, ?, ?, datetime('now','localtime'))")
                .run(c, name.trim(), parseInt(value_nis, 10) || null, parseInt(points_cost, 10) || 0);
            id = r.lastInsertRowid;
        } catch (e) {
            return res.status(400).json({ error: 'קוד מוצר זה כבר קיים' });
        }
        audit(req.user.name, 'campaign.prize.create', 'campaign_prizes', id, null, { code: c, name: name.trim() });
        events?.emit('campaign.update');
        res.json({ ok: true });
    });

    router.put('/prizes/:id', mustLogin, mustManager, (req, res) => {
        const { name, value_nis, points_cost, active } = req.body;
        const before = db.prepare('SELECT * FROM campaign_prizes WHERE id = ?').get(req.params.id);
        db.prepare('UPDATE campaign_prizes SET name = ?, value_nis = ?, points_cost = ?, active = ? WHERE id = ?')
            .run(name, parseInt(value_nis, 10) || null, parseInt(points_cost, 10) || 0, active ? 1 : 0, req.params.id);
        audit(req.user.name, 'campaign.prize.update', 'campaign_prizes', req.params.id,
            before, { name, value_nis, points_cost, active: !!active });
        events?.emit('campaign.update');
        res.json({ ok: true });
    });

    router.delete('/prizes/:id', mustLogin, mustManager, (req, res) => {
        const before = db.prepare('SELECT * FROM campaign_prizes WHERE id = ?').get(req.params.id);
        db.prepare('DELETE FROM campaign_prizes WHERE id = ?').run(req.params.id);
        audit(req.user.name, 'campaign.prize.delete', 'campaign_prizes', req.params.id, before, null);
        events?.emit('campaign.update');
        res.json({ ok: true });
    });

    // קוד המוקד (PIN) מתמספר אוטומטית ברצף — כדי שלא יהיו כפילויות או צורך להמציא קוד ידנית
    router.post('/hubs', mustLogin, mustManager, (req, res) => {
        const { name, kits_total, area_path, pickup_info } = req.body;
        if (!name || !name.trim()) return res.status(400).json({ error: 'יש להזין שם מוקד' });
        const total = parseInt(kits_total, 10) || 0;
        const maxPin = db.prepare("SELECT MAX(CAST(pin AS INTEGER)) AS m FROM campaign_hubs").get().m || 0;
        const nextPin = String(maxPin + 1);
        const r = db.prepare("INSERT INTO campaign_hubs (name, pin, kits_total, kits_available, area_path, pickup_info, created_at) VALUES (?, ?, ?, ?, ?, ?, datetime('now','localtime'))")
            .run(name.trim(), nextPin, total, total, area_path || null, pickup_info || null);
        audit(req.user.name, 'campaign.hub.create', 'campaign_hubs', r.lastInsertRowid, null, { name: name.trim(), kits_total: total, pin: nextPin });
        events?.emit('campaign.update');
        res.json({ ok: true, pin: nextPin });
    });

    router.put('/hubs/:id', mustLogin, mustManager, (req, res) => {
        const { name, kits_total, kits_available, area_path, pickup_info } = req.body;
        const before = db.prepare('SELECT * FROM campaign_hubs WHERE id = ?').get(req.params.id);
        db.prepare('UPDATE campaign_hubs SET name = ?, kits_total = ?, kits_available = ?, area_path = ?, pickup_info = ? WHERE id = ?')
            .run(name, parseInt(kits_total, 10) || 0, parseInt(kits_available, 10) || 0, area_path || null, pickup_info || null, req.params.id);
        audit(req.user.name, 'campaign.hub.update', 'campaign_hubs', req.params.id,
            before, { name, kits_total, kits_available, area_path, pickup_info });
        events?.emit('campaign.update');
        res.json({ ok: true });
    });

    router.delete('/hubs/:id', mustLogin, mustManager, (req, res) => {
        const before = db.prepare('SELECT * FROM campaign_hubs WHERE id = ?').get(req.params.id);
        db.prepare('DELETE FROM campaign_hubs WHERE id = ?').run(req.params.id);
        audit(req.user.name, 'campaign.hub.delete', 'campaign_hubs', req.params.id, before, null);
        events?.emit('campaign.update');
        res.json({ ok: true });
    });

    return router;
}
