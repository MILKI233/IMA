import { YemotRouter } from 'yemot-router2';
import {
    db, CAMPAIGN_POINTS, CAMPAIGN_GOAL_BONUS_RATE, findOrCreateVolunteer, getVolunteerBalance,
    campaignWeekStart, pointsEarnedSinceWeekStart, CAMPAIGN_GEO_TREE, findHubByAreaPath
} from './db.js';

export function createCampaignYemotRouter({ events }) {
    const router = YemotRouter({
        printLog: true,
        defaults: { removeInvalidChars: true },
        uncaughtErrorHandler: (error, call) => {
            console.error(`[campaign-yemot] שגיאה בשיחה ${call.callId} מ-${call.phone}:`, error.stack);
            return call.id_list_message([{ type: 'text', data: 'אירעה שגיאה, נסי שוב מאוחר יותר' }]);
        }
    });

    const t = (data) => ({ type: 'text', data });
    const n = (data) => ({ type: 'number', data: String(data) });

    function logTxn({ volunteerId, type, points, status = 'approved', value_nis = null, note = null, recording_path = null }) {
        db.prepare(
            `INSERT INTO campaign_point_transactions (volunteer_id, type, points, status, value_nis, note, recording_path, approved_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(volunteerId, type, points, status, value_nis, note, recording_path, status === 'approved' ? new Date().toISOString() : null);
        events?.emit('campaign.update');
    }

    function nodeLabel(node) {
        return node.letter ? `${node.name} ${node.letter}` : node.name;
    }

    async function mainMenu(call, volunteer) {
        const digit = await call.read([
            t('תפריט קמפיין המכירה הסינית, אמא במשמרת'),
            t('לצבירת נקודות ודיווח פעולה הקישי 2'),
            t('ליעד השבועי שלך הקישי 3'),
            t('למוקדי הפצה הקישי 4'),
            t('למימוש מתנה בנקודות הקישי 7'),
            t('לשיתופים, תוכן, תמיכה והודעות צוות הקישי 1')
        ], 'tap', { max_digits: 1, min_digits: 1, digits_allowed: ['1', '2', '3', '4', '5', '6', '7', '9'], sec_wait: 10 });
        await routeMain(call, volunteer, digit);
    }

    async function routeMain(call, volunteer, digit) {
        switch (digit) {
            case '2': await menuPoints(call, volunteer); break;
            case '3': await menuGoal(call, volunteer); break;
            case '4': await menuHubs(call, volunteer); break;
            case '7': await menuGift(call, volunteer); break;
            default: await menuComingSoon(call, volunteer); break;
        }
    }

    async function menuComingSoon(call, volunteer) {
        await call.read([
            t('האפשרות הזו תתווסף בשלב הבא של המערכת'),
            t('לתפריט הראשי הקישי 9')
        ], 'tap', { max_digits: 1, digits_allowed: ['9'], sec_wait: 10 });
        await mainMenu(call, volunteer);
    }

    async function menuPoints(call, volunteer) {
        const balance = getVolunteerBalance(volunteer.id);
        const ws = campaignWeekStart();
        const goalRow = db.prepare('SELECT * FROM campaign_weekly_goals WHERE volunteer_id = ? AND week_start = ?').get(volunteer.id, ws);

        const msgs = [t('צברת'), n(balance), t('נקודות')];
        if (goalRow) msgs.push(t('והיעד השבועי שלך הוא'), n(goalRow.goal_points), t('נקודות'));

        const digit = await call.read([
            ...msgs,
            t('לדיווח פעולה חדשה הקישי 2'),
            t('לתפריט הראשי הקישי 9')
        ], 'tap', { max_digits: 1, digits_allowed: ['2', '9'], sec_wait: 12 });

        if (digit === '9') return mainMenu(call, volunteer);
        await reportAction(call, volunteer);
    }

    async function reportAction(call, volunteer) {
        const key = await call.read([
            t('לפנייה לעסק והצגת חומרים הקישי 1'),
            t('לדיווח שליחות הקישי 2'),
            t('לדיווח גיוס מוצר בפועל הקישי 3')
        ], 'tap', { max_digits: 1, digits_allowed: ['1', '2', '3'], sec_wait: 12 });

        if (key === '1') {
            const pts = CAMPAIGN_POINTS().outreach;
            logTxn({ volunteerId: volunteer.id, type: 'outreach', points: pts, note: 'פנייה לעסק' });
            await call.read([
                t('נרשם, קיבלת'), n(pts), t('נקודות'),
                t('היתרה החדשה שלך היא'), n(getVolunteerBalance(volunteer.id)), t('נקודות'),
                t('לתפריט הראשי הקישי 9')
            ], 'tap', { max_digits: 1, digits_allowed: ['9'], sec_wait: 12 });
            return mainMenu(call, volunteer);
        }

        if (key === '2') {
            const pts = CAMPAIGN_POINTS().errand;
            logTxn({ volunteerId: volunteer.id, type: 'errand', points: pts, note: 'שליחות' });
            await call.read([
                t('נרשם, קיבלת'), n(pts), t('נקודות'),
                t('היתרה החדשה שלך היא'), n(getVolunteerBalance(volunteer.id)), t('נקודות'),
                t('לתפריט הראשי הקישי 9')
            ], 'tap', { max_digits: 1, digits_allowed: ['9'], sec_wait: 12 });
            return mainMenu(call, volunteer);
        }

        const value = await call.read([
            t('הקישי את שווי המוצר בשקלים ואז סולמית')
        ], 'tap', { max_digits: 6, min_digits: 1, sec_wait: 15 });

        const recordingPath = await call.read([
            t('אנא תארי בקצרה את המוצר שגייסת, ואז סולמית')
        ], 'record', { min_length: '2', max_length: '60' });

        logTxn({
            volunteerId: volunteer.id, type: 'product', points: null, status: 'pending',
            value_nis: parseInt(value, 10) || 0, note: 'גיוס מוצר - מחכה לאישור הנהלה', recording_path: recordingPath
        });

        await call.read([
            t('הדיווח שלך נשלח לאישור ההנהלה, ותעודכני בנקודות לאחר האישור'),
            t('תודה רבה!'),
            t('לתפריט הראשי הקישי 9')
        ], 'tap', { max_digits: 1, digits_allowed: ['9'], sec_wait: 12 });
        return mainMenu(call, volunteer);
    }

    async function menuGoal(call, volunteer) {
        const ws = campaignWeekStart();
        const goalRow = db.prepare('SELECT * FROM campaign_weekly_goals WHERE volunteer_id = ? AND week_start = ?').get(volunteer.id, ws);

        const digit = await call.read([
            t('שלוחת היעד השבועי שלך'),
            t('לקביעת יעד נקודות חדש לשבוע הקישי 1'),
            t('לאישור שעמדת ביעד השבועי הקישי 2'),
            t('לתפריט הראשי הקישי 9')
        ], 'tap', { max_digits: 1, digits_allowed: ['1', '2', '9'], sec_wait: 12 });

        if (digit === '9') return mainMenu(call, volunteer);

        if (digit === '1') {
            const goalDigits = await call.read([
                t('הקישי את מספר הנקודות שאת רוצה לצבור השבוע ואז סולמית')
            ], 'tap', { max_digits: 5, min_digits: 1, sec_wait: 15 });
            const goalPoints = parseInt(goalDigits, 10) || 0;
            db.prepare(
                `INSERT INTO campaign_weekly_goals (volunteer_id, week_start, goal_points) VALUES (?, ?, ?)
                 ON CONFLICT(volunteer_id, week_start) DO UPDATE SET goal_points = excluded.goal_points`
            ).run(volunteer.id, ws, goalPoints);
            events?.emit('campaign.update');
            await call.read([
                t('נקבע יעד שבועי של'), n(goalPoints), t('נקודות'), t('בהצלחה!'),
                t('לתפריט הראשי הקישי 9')
            ], 'tap', { max_digits: 1, digits_allowed: ['9'], sec_wait: 12 });
            return mainMenu(call, volunteer);
        }

        if (!goalRow) {
            await call.read([
                t('לא נקבע עדיין יעד שבועי'), t('קודם יש לקבוע יעד על ידי הקשה על 1'),
                t('לתפריט הראשי הקישי 9')
            ], 'tap', { max_digits: 1, digits_allowed: ['9'], sec_wait: 12 });
            return mainMenu(call, volunteer);
        }
        if (goalRow.bonus_claimed) {
            await call.read([t('כבר קיבלת את הבונוס השבועי, כל הכבוד'), t('לתפריט הראשי הקישי 9')],
                'tap', { max_digits: 1, digits_allowed: ['9'], sec_wait: 12 });
            return mainMenu(call, volunteer);
        }
        const earned = pointsEarnedSinceWeekStart(volunteer.id, ws);
        if (earned >= goalRow.goal_points) {
            const bonus = Math.round(goalRow.goal_points * CAMPAIGN_GOAL_BONUS_RATE());
            logTxn({ volunteerId: volunteer.id, type: 'bonus', points: bonus, note: 'בונוס עמידה ביעד שבועי' });
            db.prepare('UPDATE campaign_weekly_goals SET bonus_claimed = 1 WHERE id = ?').run(goalRow.id);
            events?.emit('campaign.update');
            await call.read([
                t('כל הכבוד! עמדת ביעד השבועי'),
                t('קיבלת במתנה בונוס של'), n(bonus), t('נקודות'),
                t('היתרה החדשה שלך היא'), n(getVolunteerBalance(volunteer.id)), t('נקודות'),
                t('לתפריט הראשי הקישי 9')
            ], 'tap', { max_digits: 1, digits_allowed: ['9'], sec_wait: 12 });
        } else {
            await call.read([
                t('עדיין לא עמדת ביעד'), t('צברת'), n(earned), t('מתוך'), n(goalRow.goal_points), t('נקודות'),
                t('לתפריט הראשי הקישי 9')
            ], 'tap', { max_digits: 1, digits_allowed: ['9'], sec_wait: 12 });
        }
        return mainMenu(call, volunteer);
    }

    async function menuGift(call, volunteer) {
        const code = await call.read([
            t('שלוחת מימוש מתנות בנקודות'),
            t('הקישי את קוד המוצר ואז סולמית')
        ], 'tap', { max_digits: 5, min_digits: 1, sec_wait: 15 });

        const prize = db.prepare('SELECT * FROM campaign_prizes WHERE code = ? AND active = 1').get(parseInt(code, 10));
        if (!prize) {
            await call.read([t('קוד לא נמצא'), t('לתפריט הראשי הקישי 9')],
                'tap', { max_digits: 1, digits_allowed: ['9'], sec_wait: 12 });
            return mainMenu(call, volunteer);
        }

        const balance = getVolunteerBalance(volunteer.id);
        const confirm = await call.read([
            t('בחרת ב'), t(prize.name),
            t('עלות המתנה היא'), n(prize.points_cost), t('נקודות'),
            t('היתרה שלך היא'), n(balance), t('נקודות'),
            t('לאישור המימוש הקישי 1, לביטול הקישי 9')
        ], 'tap', { max_digits: 1, digits_allowed: ['1', '9'], sec_wait: 15 });

        if (confirm === '9') return mainMenu(call, volunteer);

        if (balance < prize.points_cost) {
            await call.read([t('אין לך מספיק נקודות למימוש המתנה הזו'), t('לתפריט הראשי הקישי 9')],
                'tap', { max_digits: 1, digits_allowed: ['9'], sec_wait: 12 });
            return mainMenu(call, volunteer);
        }

        logTxn({ volunteerId: volunteer.id, type: 'redeem', points: -prize.points_cost, note: `מימוש מתנה: ${prize.name} (קוד ${prize.code})` });
        await call.read([
            t('המתנה אושרה, תודה!'),
            t('היתרה החדשה שלך היא'), n(getVolunteerBalance(volunteer.id)), t('נקודות'),
            t('לתפריט הראשי הקישי 9')
        ], 'tap', { max_digits: 1, digits_allowed: ['9'], sec_wait: 12 });
        return mainMenu(call, volunteer);
    }

    async function menuHubs(call, volunteer) {
        const regionMsgs = [t('שלוחת מוקדי הפצה וחלוקת קטלוגים')];
        for (const region of CAMPAIGN_GEO_TREE) regionMsgs.push(t(`ל${region.name} הקישי ${region.key}`));
        regionMsgs.push(t('לאזור ניהול מוקד הקישי 5'), t('לתפריט הראשי הקישי 9'));

        const regionKeys = CAMPAIGN_GEO_TREE.map((r) => r.key);
        const digit = await call.read(regionMsgs, 'tap', {
            max_digits: 1, digits_allowed: [...regionKeys, '5', '9'], sec_wait: 15
        });

        if (digit === '9') return mainMenu(call, volunteer);
        if (digit === '5') return hubManagerArea(call, volunteer);

        const region = CAMPAIGN_GEO_TREE.find((r) => r.key === digit);
        await browseGeo(call, volunteer, region.children, [region.name]);
    }

    async function browseGeo(call, volunteer, nodes, pathNames) {
        const msgs = [];
        for (const node of nodes) msgs.push(t(`ל${nodeLabel(node)} הקישי ${node.key}`));
        msgs.push(t('לתפריט הראשי הקישי 9'));

        const keys = nodes.map((nd) => nd.key);
        const digit = await call.read(msgs, 'tap', { max_digits: 1, digits_allowed: [...keys, '9'], sec_wait: 15 });
        if (digit === '9') return mainMenu(call, volunteer);

        const node = nodes.find((nd) => nd.key === digit);
        const names = [...pathNames, nodeLabel(node)];

        if (node.children && node.children.length > 0) {
            return browseGeo(call, volunteer, node.children, names);
        }

        const areaPath = names.join('/');
        const hub = findHubByAreaPath(areaPath);
        if (!hub) {
            await call.read([
                t('אזור זה עדיין לא הוגדר במערכת'),
                t('ניתן לפנות למזכירות בשלוחה 5'),
                t('לתפריט הראשי הקישי 9')
            ], 'tap', { max_digits: 1, digits_allowed: ['9'], sec_wait: 12 });
            return mainMenu(call, volunteer);
        }
        const infoMsgs = hub.pickup_info
            ? [t('פרטי המסירה במוקד'), t(hub.pickup_info)]
            : [t('המוקד קיים אך פרטי המסירה עדיין לא הוזנו'), t('ניתן לפנות למזכירות בשלוחה 5')];
        await call.read([...infoMsgs, t('לתפריט הראשי הקישי 9')],
            'tap', { max_digits: 1, digits_allowed: ['9'], sec_wait: 15 });
        return mainMenu(call, volunteer);
    }

    async function hubManagerArea(call, volunteer) {
        const pin = await call.read([
            t('הקישי את קוד המוקד שלך ואז סולמית')
        ], 'tap', { max_digits: 6, min_digits: 1, sec_wait: 15 });

        const hub = db.prepare('SELECT * FROM campaign_hubs WHERE pin = ?').get(pin);
        if (!hub) {
            await call.read([t('קוד לא נמצא'), t('לתפריט הראשי הקישי 9')],
                'tap', { max_digits: 1, digits_allowed: ['9'], sec_wait: 12 });
            return mainMenu(call, volunteer);
        }

        const digit = await call.read([
            t('נשארו אצלך'), n(hub.kits_available), t('ערכות פנויות למסירה מתוך'), n(hub.kits_total),
            t('לדיווח כמה קטלוגים נלקחו הקישי 1'),
            t('לשליחת הודעה למזכירות הקישי 2'),
            t('לתפריט הראשי הקישי 9')
        ], 'tap', { max_digits: 1, digits_allowed: ['1', '2', '9'], sec_wait: 15 });

        if (digit === '9') return mainMenu(call, volunteer);

        if (digit === '1') {
            const phone = await call.read([t('הקישי את מספר הטלפון שקיבל את הקטלוגים ואז סולמית')],
                'tap', { max_digits: 12, min_digits: 7, sec_wait: 15 });
            const amountDigits = await call.read([t('הקישי כמה קטלוגים נלקחו ואז סולמית')],
                'tap', { max_digits: 4, min_digits: 1, sec_wait: 15 });
            const amount = parseInt(amountDigits, 10) || 0;
            const newAvailable = Math.max(0, hub.kits_available - amount);
            db.prepare('UPDATE campaign_hubs SET kits_available = ? WHERE id = ?').run(newAvailable, hub.id);
            db.prepare('INSERT INTO campaign_hub_logs (hub_id, kind, phone, amount) VALUES (?, ?, ?, ?)')
                .run(hub.id, 'catalogs_taken', phone, amount);
            events?.emit('campaign.update');
            await call.read([
                t('נרשם, נשארו'), n(newAvailable), t('ערכות פנויות'),
                t('לתפריט הראשי הקישי 9')
            ], 'tap', { max_digits: 1, digits_allowed: ['9'], sec_wait: 12 });
            return mainMenu(call, volunteer);
        }

        const recordingPath = await call.read([
            t('אנא השאירי הודעה למזכירות ואז סולמית')
        ], 'record', { min_length: '1', max_length: '90' });
        db.prepare('INSERT INTO campaign_hub_logs (hub_id, kind, message) VALUES (?, ?, ?)')
            .run(hub.id, 'message', recordingPath);
        events?.emit('campaign.update');
        await call.read([t('ההודעה נשלחה למזכירות, תודה'), t('לתפריט הראשי הקישי 9')],
            'tap', { max_digits: 1, digits_allowed: ['9'], sec_wait: 12 });
        return mainMenu(call, volunteer);
    }

    router.get('/', async (call) => {
        const volunteer = findOrCreateVolunteer(call.phone);
        events?.emit('campaign.update');
        await mainMenu(call, volunteer);
    });

    router.events.on('new_call', (call) => {
        console.log(`[campaign-yemot] שיחה חדשה ${call.callId} מ-${call.phone}`);
    });

    return router;
}
