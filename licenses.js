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

    /**
     * Продукты — ровно те, что проверяются в коде плагинов:
     *   LVA.Civil.BIM/LVA_Ribbon.cs        → LicenseGate.Check("Civil")
     *   LVA.Navis.Tools/…AuditPropSets.cs  → LicenseGate.Check("Navis")
     *   LVA.Inventor.BIM/InventorPlugin.cs → LicenseGate.Check("Inventor")
     *
     * Вкладки ленты («Генплан», «НВК», «Электрика» и прочие) продуктами не
     * являются — это разделы внутри Civil, и лицензия у них общая.
     *
     * Значение уходит в поле Products лицензии, по нему LicenseGate решает,
     * открывать плагин или нет. Придумывать здесь свои коды нельзя: плагин их
     * не знает и отвергнет лицензию как «не включает этот продукт».
     */
    const PRODUCTS = [
        { code: 'Civil', title: 'Civil 3D / AutoCAD — все ленты LVA', group: 'Продукты' },
        { code: 'Navis', title: 'Navisworks — LVA.Navis.Tools', group: 'Продукты' },
        { code: 'Inventor', title: 'Inventor — LVA.Inventor.BIM', group: 'Продукты' },
        { code: '*', title: 'Все продукты сразу', group: 'Комплект' }
    ];

    const productTitle = (code) => PRODUCTS.find((p) => p.code === code)?.title || code;

    /** Продукты по разделам, в порядке объявления — для выпадающего списка. */
    function productGroups() {
        const out = [];
        for (const item of PRODUCTS) {
            const name = item.group || 'Продукты';
            let bucket = out.find((g) => g.name === name);
            if (!bucket) out.push((bucket = { name, items: [] }));
            bucket.items.push(item);
        }
        return out;
    }

    /** Machine ID из Get-LvaMachineId.ps1: SHA-256 hex, 64 знака. */
    const isMachineId = (v) => /^[0-9a-fA-F]{64}$/.test(String(v || '').trim());

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
            .select('id, product, org, status, comment, decision_note, machine_id, created_at, decided_at')
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
            .select('id, product, org, license_key, machine_id, issued_at, expires_at, revoked_at, revoke_reason')
            .eq('user_id', user.id)
            .order('issued_at', { ascending: false });
        if (error) throw new Error(error.message);
        return data || [];
    }

    async function createRequest({ product, org, fullName, comment, machineId }) {
        if (!product) throw new Error('Выберите продукт.');
        const machine = (machineId || '').trim().toUpperCase();
        // Лицензия привязывается к железу, и без кода компьютера выпустить её
        // нельзя. Ловим здесь, чтобы человек не ждал ответа на пустую заявку.
        if (!machine) {
            throw new Error('Укажите код компьютера — без него лицензию не выпустить. Как его получить, написано под полем.');
        }
        if (!isMachineId(machine)) {
            throw new Error('Код компьютера — это 64 знака из цифр и букв A–F. Похоже, скопировалось не полностью.');
        }
        const user = await currentUser();
        const { error } = await client().from('license_requests').insert({
            user_id: user.id,
            email: user.email,
            product,
            org: (org || '').trim(),
            full_name: (fullName || '').trim(),
            comment: (comment || '').trim(),
            machine_id: machine
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
            .select('id, user_id, email, product, org, full_name, comment, machine_id, status, decision_note, created_at, decided_at')
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
            .select('id, email, org, product, machine_id, issued_at, expires_at, revoked_at')
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
        productGroups,
        isMachineId,
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
