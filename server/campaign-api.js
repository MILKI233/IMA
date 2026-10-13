import express from 'express';
import {
    db, getVolunteerBalance, campaignWeekStart, getAllCampaignSettings, setCampaignSettings, campaignGeoLeaves
} from './db.js';

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

    router.get('/geo-leaves', mustLogin, (req, res) => {
        res.json(campaignGeoLeaves());
    });

    router.put('/settings', mustLogin, mustManager, (req, res) => {
        setCampaignSettings(req.body || {});
        events?.emit('campaign.update');
        res.json({ ok: true });
    });

    router.post('/approve/:id', mustLogin, mustManager, (req, res) => {
        const { points } = req.body;
        const pts = parseInt(points, 10);
        if (!Number.isFinite(pts) || pts < 0) return res.status(400).json({ error: 'יש להזין מספר נקודות תקין' });
        const txn = db.prepare("SELECT * FROM campaign_point_transactions WHERE id = ? AND status = 'pending'").get(req.params.id);
        if (!txn) return res.status(404).json({ error: 'הדיווח לא נמצא או שכבר טופל' });
        db.prepare("UPDATE campaign_point_transactions SET status = 'approved', points = ?, approved_at = datetime('now') WHERE id = ?")
            .run(pts, txn.id);
        events?.emit('campaign.update');
        res.json({ ok: true });
    });

    router.post('/reject/:id', mustLogin, mustManager, (req, res) => {
        const txn = db.prepare("SELECT * FROM campaign_point_transactions WHERE id = ? AND status = 'pending'").get(req.params.id);
        if (!txn) return res.status(404).json({ error: 'הדיווח לא נמצא או שכבר טופל' });
        db.prepare("UPDATE campaign_point_transactions SET status = 'rejected', points = 0, approved_at = datetime('now') WHERE id = ?")
            .run(txn.id);
        events?.emit('campaign.update');
        res.json({ ok: true });
    });

    router.put('/volunteers/:id', mustLogin, mustManager, (req, res) => {
        const { name } = req.body;
        if (!name || !name.trim()) return res.status(400).json({ error: 'יש להזין שם' });
        db.prepare('UPDATE campaign_volunteers SET name = ?, identified = 1 WHERE id = ?').run(name.trim(), req.params.id);
        events?.emit('campaign.update');
        res.json({ ok: true });
    });

    router.post('/prizes', mustLogin, mustManager, (req, res) => {
        const { code, name, value_nis, points_cost } = req.body;
        const c = parseInt(code, 10);
        if (!Number.isFinite(c) || !name || !name.trim()) return res.status(400).json({ error: 'יש להזין קוד ושם תקינים' });
        try {
            db.prepare('INSERT INTO campaign_prizes (code, name, value_nis, points_cost) VALUES (?, ?, ?, ?)')
                .run(c, name.trim(), parseInt(value_nis, 10) || null, parseInt(points_cost, 10) || 0);
        } catch (e) {
            return res.status(400).json({ error: 'קוד מוצר זה כבר קיים' });
        }
        events?.emit('campaign.update');
        res.json({ ok: true });
    });

    router.put('/prizes/:id', mustLogin, mustManager, (req, res) => {
        const { name, value_nis, points_cost, active } = req.body;
        db.prepare('UPDATE campaign_prizes SET name = ?, value_nis = ?, points_cost = ?, active = ? WHERE id = ?')
            .run(name, parseInt(value_nis, 10) || null, parseInt(points_cost, 10) || 0, active ? 1 : 0, req.params.id);
        events?.emit('campaign.update');
        res.json({ ok: true });
    });

    router.delete('/prizes/:id', mustLogin, mustManager, (req, res) => {
        db.prepare('DELETE FROM campaign_prizes WHERE id = ?').run(req.params.id);
        events?.emit('campaign.update');
        res.json({ ok: true });
    });

    router.post('/hubs', mustLogin, mustManager, (req, res) => {
        const { name, pin, kits_total, area_path, pickup_info } = req.body;
        if (!name || !name.trim() || !pin || !String(pin).trim()) return res.status(400).json({ error: 'יש להזין שם וקוד מוקד' });
        const total = parseInt(kits_total, 10) || 0;
        try {
            db.prepare('INSERT INTO campaign_hubs (name, pin, kits_total, kits_available, area_path, pickup_info) VALUES (?, ?, ?, ?, ?, ?)')
                .run(name.trim(), String(pin).trim(), total, total, area_path || null, pickup_info || null);
        } catch (e) {
            return res.status(400).json({ error: 'קוד מוקד זה כבר קיים' });
        }
        events?.emit('campaign.update');
        res.json({ ok: true });
    });

    router.put('/hubs/:id', mustLogin, mustManager, (req, res) => {
        const { name, kits_total, kits_available, area_path, pickup_info } = req.body;
        db.prepare('UPDATE campaign_hubs SET name = ?, kits_total = ?, kits_available = ?, area_path = ?, pickup_info = ? WHERE id = ?')
            .run(name, parseInt(kits_total, 10) || 0, parseInt(kits_available, 10) || 0, area_path || null, pickup_info || null, req.params.id);
        events?.emit('campaign.update');
        res.json({ ok: true });
    });

    router.delete('/hubs/:id', mustLogin, mustManager, (req, res) => {
        db.prepare('DELETE FROM campaign_hubs WHERE id = ?').run(req.params.id);
        events?.emit('campaign.update');
        res.json({ ok: true });
    });

    return router;
}
