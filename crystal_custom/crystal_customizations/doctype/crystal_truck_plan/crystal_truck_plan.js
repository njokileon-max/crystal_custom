// Copyright (c) 2026, Administrator and contributors
// For license information, please see license.txt

const CTP_API = 'crystal_custom.crystal_customizations.doctype.crystal_truck_plan.crystal_truck_plan';

frappe.ui.form.on('Crystal Truck Plan', {
    refresh: function(frm) {

        try {
            const status = frm.doc.profitability_status;
            if (status) {
                const status_colors = {
                    'Profitable': 'green',
                    'Loss': 'red'
                };
                frm.page.set_indicator(status, status_colors[status] || 'gray');
            }
        } catch (error) {
            console.warn("Crystal Truck Plan UI Warning: Failed to set indicator.");
        }

        if (!frm.is_new()) {

            try {
                frm.add_custom_button(__('Create Delivery Manifest'), function() {

                    if (frm.doc.docstatus !== 1) {
                        frappe.msgprint({
                            title: 'Action Denied',
                            indicator: 'red',
                            message: 'You must Submit the Truck Plan before generating a Manifest.'
                        });
                        return;
                    }

                    frappe.confirm(
                        __('Generate a Vehicle Delivery Manifest for this Truck Plan?'),
                        () => {
                            frappe.call({
                                method: 'crystal_custom.crystal_customizations.doctype.crystal_truck_plan.crystal_truck_plan.make_delivery_manifest',
                                args: { source_name: frm.doc.name },
                                freeze: true,
                                freeze_message: __('Generating Manifest...'),
                                callback: function(r) {
                                    if (r.message) {
                                        let is_existing = r.message.status === 'exists';
                                        let indicator_color = is_existing ? 'orange' : 'green';
                                        let title_text = is_existing ? __('Manifest Already Exists') : __('Delivery Manifest Created');

                                        let modal_body = `
                                            <div class="text-center" style="padding: 10px;">
                                                <p class="text-muted">${r.message.message}</p>
                                                <div style="margin: 20px 0;">
                                                    <a class="btn btn-primary"
                                                       href="/app/vehicle-delivery-manifest/${r.message.manifest_id}"
                                                       target="_blank">
                                                       Open Manifest: <b>${r.message.manifest_id}</b>
                                                    </a>
                                                </div>
                                            </div>`;

                                        frappe.msgprint({
                                            title: title_text,
                                            indicator: indicator_color,
                                            message: modal_body,
                                            primary_action: {
                                                label: __('Done'),
                                                action: function() {
                                                    frappe.hide_msgprint();
                                                }
                                            }
                                        });
                                    }
                                }
                            });
                        }
                    );
                }, __('Nexus Actions'));
            } catch (error) {
                console.error("Error loading Manifest button.");
            }

            // ── Batch 12: Reconcile Dispatch ─────────────────────────────────
            try {
                if (frm.doc.docstatus < 2 && frappe.perm.has_perm('Crystal Truck Plan', 0, 'submit')) {
                    frm.add_custom_button(__('Reconcile Dispatch'), () => ctp_open_reconcile(frm), __('Nexus Actions'));
                }
                if (frm.doc.docstatus === 1 && !(frm.doc.orders || []).length) {
                    frm.set_intro(__('This plan was submitted without orders or a route. Use <b>Nexus Actions → Reconcile Dispatch</b> to load its Delivery Notes, route and costs (the manifest updates too).'), 'orange');
                }
            } catch (error) {
                console.error('Error loading Reconcile Dispatch button.', error);
            }
        }
    }
});

// ============================================================================
// RECONCILE DISPATCH
// Step 1: find Delivery Notes (date + vehicle, the plan's own orders, or one
//         typed in), tick / untick, pick the route engine.
// Step 2: review the full result (nothing saved yet).
// Step 3: apply — the same engine as Dispatch: rows, route, distance, GeoJSON,
//         fuel, margin, Sales Orders and the manifest.
// ============================================================================
const ctp_esc = (v) => frappe.utils.escape_html(v == null ? '' : String(v));
const ctp_money = (v) => format_currency(v || 0, null, 0);

function ctp_open_reconcile(frm) {
    const state = {
        rows: new Map(),          // delivery_note -> summary
        selected: new Set(),
        legacy: [],
        removed: new Set(),
        routing: null,
        provider_touched: false,
        setting_provider: false,
        manifest: null,
    };

    const plan_date = frm.doc.plan_date || frappe.datetime.get_today();
    const d = new frappe.ui.Dialog({
        title: __('Reconcile Dispatch: {0}', [frm.doc.truck_number || frm.doc.name]),
        size: 'extra-large',
        fields: [
            {
                fieldtype: 'HTML', fieldname: 'intro',
                options: `<div class="text-muted small" style="margin-bottom:8px">${__('Pulls the <b>submitted Delivery Notes</b> loaded on this truck. Each Delivery Note becomes one stop, with what was actually delivered. Nothing is saved until you review and confirm.')}</div>`,
            },
            { fieldtype: 'Date', fieldname: 'from_date', label: __('From Date'), default: plan_date, reqd: 1 },
            { fieldtype: 'Date', fieldname: 'to_date', label: __('To Date'), default: frappe.datetime.get_today(), reqd: 1 },
            { fieldtype: 'Column Break' },
            { fieldtype: 'Data', fieldname: 'vehicle_no', label: __('Vehicle No (on the Delivery Note)'), default: frm.doc.truck_number || '', reqd: 1 },
            { fieldtype: 'Button', fieldname: 'find_btn', label: __('Find Delivery Notes'), click: () => load(true) },
            { fieldtype: 'Column Break' },
            {
                fieldtype: 'Link', fieldname: 'add_dn', label: __('Add a Delivery Note'), options: 'Delivery Note',
                get_query: () => ({ filters: { docstatus: 1, is_return: 0 } }),
                onchange: () => add_one(),
            },
            { fieldtype: 'Section Break', label: __('Delivery Notes') },
            { fieldtype: 'HTML', fieldname: 'dn_html' },
            { fieldtype: 'Section Break', fieldname: 'legacy_section', label: __('Orders on this plan without a Delivery Note'), hidden: 1 },
            { fieldtype: 'HTML', fieldname: 'legacy_html' },
            { fieldtype: 'Section Break', label: __('Route & distance engine') },
            {
                fieldtype: 'Select', fieldname: 'route_provider', label: __('Engine'),
                options: [
                    { label: __('Google Maps (latest roads, 1 request)'), value: 'Google' },
                    { label: __('Hosted (Nexus server)'), value: 'Hosted' },
                ],
                default: 'Hosted', reqd: 1,
                onchange: () => {
                    if (state.setting_provider) return;
                    state.provider_touched = true;
                    render_provider_note();
                },
            },
            { fieldtype: 'Column Break' },
            { fieldtype: 'HTML', fieldname: 'provider_note' },
        ],
        primary_action_label: __('Review Changes'),
        primary_action: () => review(),
    });

    function args_base() {
        return { plan_name: frm.doc.name };
    }

    function load(with_search) {
        const v = d.get_values(true) || {};
        const args = args_base();
        if (with_search) {
            if (!v.vehicle_no || !v.from_date || !v.to_date) {
                frappe.msgprint(__('Enter the dates and the Vehicle No.'));
                return;
            }
            Object.assign(args, { from_date: v.from_date, to_date: v.to_date, vehicle_no: v.vehicle_no });
        }
        d.fields_dict.dn_html.$wrapper.html(`<div class="text-muted small"><i class="fa fa-spinner fa-spin"></i> ${__('Loading Delivery Notes...')}</div>`);
        frappe.call({ method: `${CTP_API}.get_reconcile_candidates`, args }).then((r) => {
            const res = r.message || {};
            const keep_selection = new Set(state.selected);
            const had_rows = state.rows.size > 0;
            (res.delivery_notes || []).forEach((row) => {
                const existed = state.rows.has(row.name);
                state.rows.set(row.name, row);
                if (row.locked) state.selected.add(row.name);
                else if (!existed && row.selected) state.selected.add(row.name);
                else if (existed && !keep_selection.has(row.name)) state.selected.delete(row.name);
                if ((row.problems || []).length && !row.locked) state.selected.delete(row.name);
            });
            if (!had_rows && !(res.delivery_notes || []).length && with_search) {
                frappe.show_alert({ message: __('No submitted Delivery Notes for this vehicle and dates.'), indicator: 'orange' });
            }
            state.legacy = res.legacy_orders || [];
            state.routing = res.routing || state.routing;
            state.manifest = res.manifest || null;
            render();
        });
    }

    function add_one() {
        const name = d.get_value('add_dn');
        if (!name) return;
        if (state.rows.has(name)) {
            state.selected.add(name);
            d.set_value('add_dn', '');
            render();
            return;
        }
        frappe.call({ method: `${CTP_API}.get_delivery_note_for_reconcile`, args: { ...args_base(), delivery_note: name } }).then((r) => {
            const row = r.message;
            if (row) {
                state.rows.set(row.name, row);
                if (row.selected) state.selected.add(row.name);
                if ((row.problems || []).length) {
                    frappe.show_alert({ message: __('{0} can\'t be used: {1}', [row.name, row.problems.join(', ')]), indicator: 'red' }, 7);
                }
            }
            d.set_value('add_dn', '');
            render();
        });
    }

    function selected_rows() {
        return [...state.rows.values()].filter((r) => state.selected.has(r.name));
    }

    function render() {
        render_dns();
        render_legacy();
        render_provider_note();
    }

    function render_dns() {
        const rows = [...state.rows.values()];
        const $w = d.fields_dict.dn_html.$wrapper;
        if (!rows.length) {
            $w.html(`<div class="text-muted small">${__('No Delivery Notes yet. Choose the dates and Vehicle No, then press Find Delivery Notes, or add one by number.')}</div>`);
            return;
        }
        const sel = selected_rows();
        const totals = {
            value: sel.reduce((s, r) => s + (r.grand_total || 0), 0),
            weight: sel.reduce((s, r) => s + (r.total_net_weight || 0), 0),
            located: sel.filter((r) => r.has_location).length,
        };
        const body = rows.map((r) => {
            const bad = (r.problems || []).length > 0;
            const checked = state.selected.has(r.name);
            const disabled = (bad && !r.locked) || r.locked;
            const loc = r.has_location
                ? `<span class="indicator-pill green">${__('Mapped')}</span>`
                : `<span class="indicator-pill orange">${__('No GPS')}</span>`;
            const note = bad
                ? `<span class="text-danger">${ctp_esc(r.problems.join(', '))}</span>`
                : (r.locked ? `<span class="text-muted">${__('Already confirmed on the manifest')}</span>`
                    : ((r.other_trucks || []).length ? `<span class="text-warning">${__('Order now on truck {0}', [ctp_esc(r.other_trucks.join(', '))])}</span>` : ctp_esc(r.source || '')));
            return `<tr class="${bad ? 'text-muted' : ''}">
                <td class="text-center"><input type="checkbox" class="ctp-dn-chk" data-dn="${ctp_esc(r.name)}" ${checked ? 'checked' : ''} ${disabled ? 'disabled' : ''}></td>
                <td><a href="/app/delivery-note/${encodeURIComponent(r.name)}" target="_blank">${ctp_esc(r.name)}</a><div class="small text-muted">${ctp_esc(r.posting_date || '')} · ${ctp_esc(r.vehicle_no || '')}</div></td>
                <td>${ctp_esc(r.customer_name || r.customer || '')}<div class="small text-muted">${ctp_esc((r.sales_orders || []).join(', '))}</div></td>
                <td>${loc}</td>
                <td class="text-right">${r.item_count || 0}</td>
                <td class="text-right">${(r.total_net_weight || 0).toFixed(1)} kg</td>
                <td class="text-right">${ctp_money(r.grand_total)}</td>
                <td class="small">${note}</td>
            </tr>`;
        }).join('');
        $w.html(`
            <div class="small" style="margin-bottom:6px">
                <b>${sel.length}</b> ${__('selected')} · ${totals.weight.toFixed(1)} kg · ${ctp_money(totals.value)} · ${totals.located}/${sel.length} ${__('with a location')}
            </div>
            <div style="max-height:340px;overflow:auto">
            <table class="table table-bordered table-sm small" style="margin:0">
                <thead><tr><th></th><th>${__('Delivery Note')}</th><th>${__('Customer / Sales Orders')}</th><th>${__('Location')}</th>
                <th class="text-right">${__('Lines')}</th><th class="text-right">${__('Weight')}</th><th class="text-right">${__('Value')}</th><th>${__('Note')}</th></tr></thead>
                <tbody>${body}</tbody>
            </table></div>`);
        $w.find('.ctp-dn-chk').on('change', function () {
            const dn = $(this).attr('data-dn');
            if (this.checked) state.selected.add(dn); else state.selected.delete(dn);
            render();
        });
    }

    function render_legacy() {
        const covered = new Set(selected_rows().flatMap((r) => r.sales_orders || []));
        const rows = state.legacy;
        d.set_df_property('legacy_section', 'hidden', !rows.length);
        if (!rows.length) { d.fields_dict.legacy_html.$wrapper.empty(); return; }
        const body = rows.map((o) => {
            const is_covered = covered.has(o.sales_order);
            const removed = state.removed.has(o.sales_order);
            const status = is_covered
                ? `<span class="text-success">${__('Covered by a selected Delivery Note')}</span>`
                : (removed ? `<span class="text-muted">${__('Will be removed from the plan')}</span>`
                    : `<span class="text-danger">${ctp_esc(o.reason || __('No Delivery Note selected'))}</span>`);
            return `<tr>
                <td><a href="/app/sales-order/${encodeURIComponent(o.sales_order)}" target="_blank">${ctp_esc(o.sales_order)}</a></td>
                <td>${ctp_esc(o.customer_name)}</td>
                <td class="small">${status}</td>
                <td class="text-center"><label class="small" style="margin:0"><input type="checkbox" class="ctp-rm-chk" data-so="${ctp_esc(o.sales_order)}"
                    ${removed ? 'checked' : ''} ${(is_covered || o.locked) ? 'disabled' : ''}> ${__('Remove from plan')}</label></td>
            </tr>`;
        }).join('');
        d.fields_dict.legacy_html.$wrapper.html(`
            <div class="text-muted small" style="margin-bottom:6px">${__('These orders are on the plan from before Delivery Notes were used. Each needs a selected Delivery Note, or must be removed.')}</div>
            <table class="table table-bordered table-sm small" style="margin:0">
                <thead><tr><th>${__('Sales Order')}</th><th>${__('Customer')}</th><th>${__('Status')}</th><th></th></tr></thead>
                <tbody>${body}</tbody></table>`);
        d.fields_dict.legacy_html.$wrapper.find('.ctp-rm-chk').on('change', function () {
            const so = $(this).attr('data-so');
            if (this.checked) state.removed.add(so); else state.removed.delete(so);
            render_legacy();
        });
    }

    function render_provider_note() {
        const r = state.routing || {};
        const located = selected_rows().filter((x) => x.has_location).length;
        const max = r.google_max_stops || 25;
        const google_ok = !!r.google_configured && located <= max;
        const wanted = google_ok && located > 0 ? 'Google' : 'Hosted';
        if (!state.provider_touched && d.get_value('route_provider') !== wanted) {
            state.setting_provider = true;
            Promise.resolve(d.set_value('route_provider', wanted)).finally(() => { state.setting_provider = false; });
        }
        let note;
        if (!r.google_configured) note = __('Google routing isn\'t set up (Nexus App Settings → Google Maps Server API Key). Hosted will be used.');
        else if (located > max) note = __('{0} located stops: Google takes at most {1} in one request, so Hosted is used.', [located, max]);
        else note = __('{0} located stop(s): Google = 1 request (latest roads and shortcuts). Hosted = Nexus server, no Google cost.', [located]);
        if (d.get_value('route_provider') === 'Google' && !google_ok) note += ' ' + __('Google can\'t be used here; Hosted will run instead.');
        d.fields_dict.provider_note.$wrapper.html(`<div class="text-muted small" style="margin-top:28px">${note}</div>`);
    }

    function review() {
        const dns = [...state.selected];
        const route_provider = d.get_value('route_provider');
        frappe.call({
            method: `${CTP_API}.preview_reconcile`,
            args: { ...args_base(), delivery_notes: JSON.stringify(dns), removed_orders: JSON.stringify([...state.removed]), route_provider },
            freeze: true, freeze_message: __('Checking...'),
        }).then((r) => {
            const p = r.message || {};
            if (p.status !== 'ok') { show_blocked(p); return; }
            show_review(p);
        });
    }

    function show_blocked(p) {
        const b = p.blocked || {};
        const parts = [];
        if ((b.uncovered || []).length) {
            parts.push(`<p><b>${__('Delivery Note missing')}</b>: ${__('these orders have no selected Delivery Note, so the plan can\'t be reconciled.')}</p>
                <table class="table table-bordered table-sm small"><thead><tr><th>${__('Sales Order')}</th><th>${__('Customer')}</th><th>${__('Reason')}</th></tr></thead><tbody>
                ${b.uncovered.map((m) => `<tr><td>${ctp_esc(m.sales_order)}</td><td>${ctp_esc(m.customer_name)}</td><td>${ctp_esc(m.reason)}</td></tr>`).join('')}</tbody></table>`);
        }
        if ((b.problems || []).length) {
            parts.push(`<p><b>${__('Delivery Notes that can\'t be used')}</b></p><ul>${b.problems.map((x) => `<li>${ctp_esc(x.delivery_note)}: ${ctp_esc(x.problems.join(', '))}</li>`).join('')}</ul>`);
        }
        if ((b.confirmed || []).length) {
            parts.push(`<p><b>${__('Already delivered')}</b>: ${__('these stops are confirmed on the manifest and can\'t be removed.')}</p><ul>${b.confirmed.map((x) => `<li>${ctp_esc(x.label)} (${ctp_esc(x.status)})</li>`).join('')}</ul>`);
        }
        if (b.permission) parts.push(`<p>${ctp_esc(b.permission)}</p>`);
        if (b.empty) parts.push(`<p>${__('Select at least one Delivery Note.')}</p>`);
        frappe.msgprint({ title: __('Can\'t Reconcile Yet'), indicator: 'red', wide: true, message: parts.join('') });
    }

    function show_review(p) {
        const m = p.manifest || {};
        const t = p.totals || {};
        const manifest_line = {
            none: __('No Delivery Manifest yet: create it afterwards with Create Delivery Manifest.'),
            rebuild: __('Draft manifest {0}: its stops will be rebuilt from these Delivery Notes.', [ctp_esc(m.manifest)]),
            live: __('Manifest {0} ({1}): {2} stop(s) added, {3} pending stop(s) removed; confirmed stops are kept. The driver\'s app refreshes.', [ctp_esc(m.manifest), ctp_esc(m.trip_status), m.add || 0, m.remove || 0]),
            skip: __('Manifest {0} is {1}: its stops won\'t change.', [ctp_esc(m.manifest), ctp_esc(m.trip_status)]),
        }[m.action] || '';
        const stops = (p.stops || []).map((s, i) => `<tr>
            <td>${i + 1}</td>
            <td>${ctp_esc(s.delivery_note)} ${s.change === 'added' ? `<span class="indicator-pill green">${__('new')}</span>` : ''}</td>
            <td>${ctp_esc(s.customer_name)}<div class="small text-muted">${ctp_esc((s.sales_orders || []).join(', '))}</div></td>
            <td>${s.has_location ? __('Mapped') : `<span class="text-warning">${__('No GPS: left out of the route')}</span>`}</td>
            <td class="text-right">${(s.total_net_weight || 0).toFixed(1)} kg</td>
            <td class="text-right">${ctp_money(s.grand_total)}</td></tr>`).join('');
        const bullet = (label, list) => (list || []).length ? `<li>${label}: <b>${ctp_esc(list.join(', '))}</b></li>` : '';
        const html = `
            <div class="small">
            <p>${__('Plan {0} will be {1} with <b>{2}</b> Delivery Note stop(s) · {3} kg · {4}.', [ctp_esc(frm.doc.name), p.plan_docstatus === 0 ? __('submitted') : __('updated'), (p.stops || []).length, (t.weight || 0).toFixed(1), ctp_money(t.value)])}</p>
            <ul>
                <li>${__('Route engine')}: <b>${ctp_esc(p.route_provider)}</b> ${p.provider_note ? `<span class="text-muted">(${ctp_esc(p.provider_note)})</span>` : ''} · ${t.located || 0} ${__('located')}, ${t.unlocated || 0} ${__('without location')}</li>
                ${bullet(__('Removed Delivery Notes'), p.removed_delivery_notes)}
                ${bullet(__('Orders removed from the plan'), p.removed_orders)}
                ${bullet(__('Sales Orders released back to Truck Assignment'), p.released_sales_orders)}
                ${bullet(__('Orders currently on another truck (they move to this trip)'), p.other_trucks)}
                <li>${manifest_line}</li>
            </ul>
            <div style="max-height:300px;overflow:auto">
            <table class="table table-bordered table-sm" style="margin:0"><thead><tr><th>#</th><th>${__('Delivery Note')}</th><th>${__('Customer')}</th><th>${__('Location')}</th><th class="text-right">${__('Weight')}</th><th class="text-right">${__('Value')}</th></tr></thead>
            <tbody>${stops}</tbody></table></div>
            <p class="text-muted" style="margin-top:8px">${__('The stop order shown is before routing; the route sets the final order. Distance, route, fuel and margin are recomputed from these Delivery Notes.')}</p>
            </div>`;

        const confirm = new frappe.ui.Dialog({
            title: __('Review Reconciliation'),
            size: 'large',
            fields: [{ fieldtype: 'HTML', fieldname: 'body', options: html }],
            primary_action_label: __('Apply Reconciliation'),
            primary_action: () => {
                confirm.get_primary_btn().prop('disabled', true);
                frappe.call({
                    method: `${CTP_API}.reconcile_dispatch`,
                    args: { ...args_base(), delivery_notes: JSON.stringify(p.delivery_notes || []), removed_orders: JSON.stringify(p.removed_orders || []), route_provider: p.route_provider },
                    freeze: true, freeze_message: __('Reconciling dispatch: routing, costing and updating the manifest...'),
                }).then((r) => {
                    confirm.hide();
                    d.hide();
                    show_result(r.message || {});
                    frm.reload_doc();
                }).catch(() => confirm.get_primary_btn().prop('disabled', false));
            },
        });
        confirm.show();
    }

    function show_result(res) {
        const m = res.manifest || {};
        const warnings = (res.warnings || []).map((w) => `<li>${ctp_esc(w)}</li>`).join('');
        const manifest_btn = m.manifest
            ? `<a class="btn btn-primary btn-sm" href="/app/vehicle-delivery-manifest/${encodeURIComponent(m.manifest)}" target="_blank">${__('Open Manifest {0}', [ctp_esc(m.manifest)])}</a>`
            : `<span class="text-muted">${ctp_esc(m.message || '')}</span>`;
        frappe.msgprint({
            title: __('Dispatch Reconciled'),
            indicator: warnings ? 'orange' : 'green',
            message: `<div class="small">
                <p>${__('{0} stop(s) · route: <b>{1}</b> · {2} km', [res.stop_count || 0, ctp_esc(res.route_provider || __('none')), (res.distance_km || 0).toFixed(1)])}</p>
                ${warnings ? `<ul>${warnings}</ul>` : ''}
                <div style="margin-top:10px">${manifest_btn}</div></div>`,
        });
    }

    d.show();
    load(!!frm.doc.truck_number);
}
