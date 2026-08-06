/**
 * BIM.LVA — работа с лицензиями из браузера.
 *
 * Здесь нет и не может быть выпуска ключей: подписывает их только Edge Function
 * `license-issue`, где лежит секрет. Этот файл умеет спросить и показать —
 * создать заявку, прочитать свои, а для админа вызвать функцию выпуска.
 * Всё, что он присылает серверу, сервер перепроверяет заново.
 */
(function (global) {
    'use strict';

    /** Продукты, на которые можно запросить лицензию. */
    const PRODUCTS = [
        { code: 'ksi-mapper', title: 'KSI Mapper Ultimate' },
        { code: 'bim-checker', title: 'BIM Чекер (Navisworks)' },
        { code: 'matrix-builder', title: 'LVA BIM Matrix Builder' },
        { code: 'clash-group', title: 'Clash Group Automator' },
        { code: 'surface-cutter', title: 'SurfaceCutter Pro' },
        { code: 'plant3d-link', title: 'Plant 3D Data Link' }
    ];

    const productTitle = (code) => PRODUCTS.find((p) => p.code === code)?.title || code;

    function client() {
        const auth = global.BimLvaAuth;
        if (!auth || auth.mode?.() !== 'supabase') {
            throw new Error('Лицензии работают только при входе через аккаунт BIM.LVA.');
        }
        const sb = auth.getSupabaseClient();
        if (!sb) throw new Error('Нет связи с сервером аккаунтов.');
        return sb;
    }

    async function currentUser() {
        const { data } = await client().auth.getUser();
        if (!data?.user) throw new Error('Сначала войдите в аккаунт.');
        return data.user;
    }

    /** Свои заявки — новые сверху. */
    async function listMyRequests() {
        const user = await currentUser();
        const { data, error } = await client()
            .from('license_requests')
            .select('id, product, org, status, comment, decision_note, created_at, decided_at')
            .eq('user_id', user.id)
            .order('created_at', { ascending: false });
        if (error) throw new Error(error.message);
        return data || [];
    }

    /** Свои лицензии. */
    async function listMyLicenses() {
        const user = await currentUser();
        const { data, error } = await client()
            .from('licenses')
            .select('id, product, org, license_key, issued_at, expires_at, revoked_at, revoke_reason')
            .eq('user_id', user.id)
            .order('issued_at', { ascending: false });
        if (error) throw new Error(error.message);
        return data || [];
    }

    async function createRequest({ product, org, fullName, comment }) {
        if (!product) throw new Error('Выберите продукт.');
        const user = await currentUser();
        const { error } = await client().from('license_requests').insert({
            user_id: user.id,
            email: user.email,
            product,
            org: (org || '').trim(),
            full_name: (fullName || '').trim(),
            comment: (comment || '').trim()
        });
        if (error) {
            // Уникальный индекс на открытую заявку — не ошибка, а ответ по сути.
            if (/duplicate key|unique/i.test(error.message)) {
                throw new Error('Заявка на этот продукт уже отправлена и ждёт рассмотрения.');
            }
            throw new Error(error.message);
        }
    }

    /** Админ ли текущий пользователь: видно только свою строку. */
    async function isAdmin() {
        try {
            const user = await currentUser();
            const { data } = await client()
                .from('license_admins')
                .select('user_id')
                .eq('user_id', user.id)
                .maybeSingle();
            return !!data;
        } catch {
            return false;
        }
    }

    /** Все заявки — вернёт что-то только админу, так настроен RLS. */
    async function listAllRequests(status) {
        let q = client()
            .from('license_requests')
            .select('id, user_id, email, product, org, full_name, comment, status, decision_note, created_at, decided_at')
            .order('created_at', { ascending: false })
            .limit(200);
        if (status) q = q.eq('status', status);
        const { data, error } = await q;
        if (error) throw new Error(error.message);
        return data || [];
    }

    async function listAllLicenses() {
        const { data, error } = await client()
            .from('licenses')
            .select('id, email, org, product, issued_at, expires_at, revoked_at')
            .order('issued_at', { ascending: false })
            .limit(200);
        if (error) throw new Error(error.message);
        return data || [];
    }

    /** Вызов Edge Function. Ключ подписи здесь недоступен — и в этом смысл. */
    async function callIssueFunction(payload) {
        const { data, error } = await client().functions.invoke('license-issue', { body: payload });
        if (error) {
            // Тело ответа полезнее, чем «non-2xx status code».
            let detail = '';
            try { detail = (await error.context?.json())?.error || ''; } catch (_) {}
            throw new Error(detail || error.message);
        }
        if (data?.error) throw new Error(data.error);
        return data;
    }

    const issueLicense = (requestId, days, note) =>
        callIssueFunction({ action: 'issue', requestId, days, note });
    const rejectRequest = (requestId, note) =>
        callIssueFunction({ action: 'reject', requestId, note });
    const revokeLicense = (licenseId, note) =>
        callIssueFunction({ action: 'revoke', licenseId, note });

    global.BimLvaLicenses = {
        PRODUCTS,
        productTitle,
        listMyRequests,
        listMyLicenses,
        createRequest,
        isAdmin,
        listAllRequests,
        listAllLicenses,
        issueLicense,
        rejectRequest,
        revokeLicense
    };
})(typeof window !== 'undefined' ? window : globalThis);
