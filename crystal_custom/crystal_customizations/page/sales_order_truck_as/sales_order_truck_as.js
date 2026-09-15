frappe.pages['sales-order-truck-as'].on_page_load = function(wrapper) {
	var page = frappe.ui.make_app_page({
		parent: wrapper,
		title: 'Truck Assignment',
		single_column: true,
	});
	new TruckAssignmentManager(page);
};

class TruckAssignmentManager {
	constructor(page) {
		this.page = page;
		this.orders = [];
		this.available_trucks = [];
		this.search_term = '';
		this.selected_orders = new Set();
		this.selected_trucks = new Set();
		this.saved_meta = {};
		this.closed_trucks = [];
		this.trucks_tab = 'active';
		this._sps = new Set();
		this._regions = new Set();
		this.profitability_threshold = 33;
		this.setup_page();
		this.load_trucks_from_orders();
		this._fetch_fleet_settings();
		this.vehicle_capacity_map = {};
	}

	// ── Toolbar ───────────────────────────────────────────────────────────────

	setup_page() {
		const today = frappe.datetime.get_today();

		this.page.add_field({
			label: 'From Date', fieldtype: 'Date', fieldname: 'from_date',
			default: frappe.datetime.add_days(today, -30),
			change: () => this.load_data(),
		});
		this.page.add_field({
			label: 'To Date', fieldtype: 'Date', fieldname: 'to_date',
			default: today,
			change: () => this.load_data(),
		});
		this.page.add_field({
			label: 'Region', fieldtype: 'Link', fieldname: 'delivery_region',
			options: 'Delivery Region',
			placeholder: 'Add…',
			change: () => {
				const v = this.page.fields_dict.delivery_region.get_value();
				if (!v) return;
				this._regions.add(v);
				setTimeout(() => this.page.fields_dict.delivery_region.set_value(''), 50);
				this._render_region_pills();
				this.load_data();
			},
		});
		this._region_pills_wrap = $('<div class="region-pills-wrap"></div>').appendTo(this.page.page_form);
		this.page.add_field({
			label: 'Sales Person', fieldtype: 'Link', fieldname: 'sales_person',
			options: 'Sales Person',
			placeholder: 'Add…',
			change: () => {
				const v = this.page.fields_dict.sales_person.get_value();
				if (!v) return;
				this._sps.add(v);
				setTimeout(() => this.page.fields_dict.sales_person.set_value(''), 50);
				this._render_sp_pills();
				this.load_data();
			}
		});
		this._sp_pills_wrap = $('<div class="sp-pills-wrap"></div>').appendTo(this.page.page_form);
		this.page.add_field({
			label: 'Search', fieldtype: 'Data', fieldname: 'search_query',
			placeholder: 'Customer or order no…',
			change: () => {
				this.search_term = this.page.fields_dict.search_query.get_value() || '';
				
				this.render_view();
			},
		});

		this.page.set_primary_action('Add Truck', () => this.add_new_truck(), 'octicon octicon-plus');
		this.page.add_button('Refresh', () => this.load_data(), 'octicon octicon-sync');

		this.container = $('<div class="ta-container"></div>').appendTo(this.page.main);
		if (!$('#nexus-map-styles').length) {
    $('<style id="nexus-map-styles">').text(`
        .nexus-map-marker { background-color:#1e3a8a;color:#fff;border-radius:50%;width:28px;height:28px;display:flex;align-items:center;justify-content:center;border:2px solid #fff;box-shadow:0 2px 6px rgba(0,0,0,.4);font-size:13px;font-weight:bold; }
        .nexus-factory-marker { background-color:#0f172a;color:#fbbf24;border-radius:6px;width:36px;height:36px;display:flex;align-items:center;justify-content:center;border:2px solid #fff;box-shadow:0 4px 10px rgba(0,0,0,.5);font-size:18px; }
        .nexus-route-panel { position:fixed;top:0;right:-60vw;width:55vw;height:100vh;background:#fff;box-shadow:-10px 0 30px rgba(0,0,0,.2);z-index:9999;transition:right .35s cubic-bezier(.4,0,.2,1);display:flex;flex-direction:column; }
        .nexus-route-panel.active { right:0; }
        .nexus-panel-backdrop { position:fixed;top:0;left:0;width:100vw;height:100vh;background:rgba(15,23,42,.6);z-index:9998;display:none;backdrop-filter:blur(3px); }
        .nexus-panel-backdrop.active { display:block; }
        .nexus-panel-header { display:flex;justify-content:space-between;align-items:flex-start;padding:16px 20px;background:#1e293b;color:#fff;border-bottom:1px solid #334155; }
        .nexus-panel-title { font-size:18px;font-weight:700;margin-top:4px;color:#fff; }
        .btn-close-panel { background:transparent;border:none;color:#94a3b8;font-size:28px;line-height:1;padding:0;cursor:pointer; }
        .btn-close-panel:hover { color:#fff; }
        .nexus-fuel-banner { display:flex;justify-content:space-between;padding:15px 20px;background:#f8fafc;border-bottom:2px solid #e2e8f0; }
        .nexus-eco-stat { display:flex;flex-direction:column; }
        .nexus-eco-stat span { font-size:11px;text-transform:uppercase;color:#64748b;font-weight:700; }
        .nexus-eco-stat b { font-size:18px;color:#0f172a; }
        .nexus-margin-panel { position:fixed;top:0;left:-60vw;width:55vw;height:100vh;background:#fff;box-shadow:10px 0 30px rgba(0,0,0,.2);z-index:9999;transition:left .35s cubic-bezier(.4,0,.2,1);display:flex;flex-direction:column; }
        .nexus-margin-panel.active { left:0; }
        .nexus-margin-backdrop { position:fixed;top:0;left:0;width:100vw;height:100vh;background:rgba(15,23,42,.6);z-index:9998;display:none;backdrop-filter:blur(3px); }
        .nexus-margin-backdrop.active { display:block; }
        .nexus-margin-panel-title { font-size:18px;font-weight:700;margin-top:4px;color:#fff; }
        .btn-close-margin-panel { background:transparent;border:none;color:#94a3b8;font-size:28px;line-height:1;padding:0;cursor:pointer; }
        .btn-close-margin-panel:hover { color:#fff; }
        .margin-stat-row { display:flex;justify-content:space-between;align-items:center;padding:10px 0;border-bottom:1px solid #f1f5f9; }
        .margin-stat-label { font-size:12px;color:#64748b;font-weight:600;text-transform:uppercase;letter-spacing:.4px; }
        .margin-stat-value { font-size:15px;font-weight:700;color:#0f172a; }
        .margin-headline { text-align:center;padding:20px;border-radius:10px;margin-top:16px; }
        .margin-headline.profitable { background:#dcfce7;border:2px solid #10b981; }
        .margin-headline.loss { background:#fee2e2;border:2px solid #ef4444; }
        .margin-headline-value { font-size:28px;font-weight:900; }
        .margin-headline-pct { font-size:16px;font-weight:700;margin-top:4px; }
        .margin-zero-cost-warning { background:#fffbeb;border:1px solid #fde68a;border-radius:8px;padding:12px;margin-top:16px;font-size:12px;color:#92400e; }
        .btn-black-action { background:#111827 !important;color:#fff !important;font-weight:600 !important;border:1px solid #111827 !important; }
        .btn-black-action:hover { background:#000 !important; }
        .btn-black-action:disabled { background:#6b7280 !important;border-color:#6b7280 !important;opacity:.7; }
    `).appendTo('head');
}

this.map_panel = $(`
    <div class="nexus-route-panel">
        <div class="nexus-panel-header">
            <div><div style="font-size:11px;text-transform:uppercase;color:#94a3b8;">Route Optimization</div>
            <div class="nexus-panel-title">Active Route</div></div>
            <button class="btn-close-panel">&times;</button>
        </div>
        <div class="nexus-fuel-banner" style="display:none;">
            <div class="nexus-eco-stat"><span>Distance</span><b id="nx-dist">0 km</b></div>
            <div class="nexus-eco-stat"><span>Est. Duration</span><b id="nx-dur">0 hrs</b></div>
            <div class="nexus-eco-stat"><span>Fuel Est. (KES)</span><b id="nx-fuel-cost" style="color:#ef4444">0</b></div>
        </div>
        <div id="nexus-unmapped-banner" style="display:none;background:#fffbeb;border-bottom:1px solid #fef3c7;padding:12px 20px;font-size:12px;color:#92400e;">
            <div style="font-weight:700;"><i class="fa fa-exclamation-triangle"></i> Unmapped Orders Excluded:</div>
            <div id="nexus-unmapped-list" style="line-height:1.4;"></div>
        </div>
        <div id="nexus-leaflet-map" style="flex-grow:1;background:#e2e8f0;"></div>
    </div>
    <div class="nexus-panel-backdrop"></div>
`).appendTo(this.page.wrapper);

this.map_panel.find('.btn-close-panel, .nexus-panel-backdrop').on('click', () => {
    this.page.wrapper.find('.nexus-route-panel, .nexus-panel-backdrop').removeClass('active');
});

this.margin_panel = $(`
    <div class="nexus-margin-panel">
        <div class="nexus-panel-header">
            <div><div style="font-size:11px;text-transform:uppercase;color:#94a3b8;">Margin Analysis</div>
            <div class="nexus-margin-panel-title">Margin Preview</div></div>
            <button class="btn-close-margin-panel">&times;</button>
        </div>
        <div id="nexus-margin-content" style="flex-grow:1;overflow-y:auto;padding:20px;">
            <div class="text-center text-muted py-5">Select a truck or orders and click "Analyse Margins".</div>
        </div>
    </div>
    <div class="nexus-margin-backdrop"></div>
`).appendTo(this.page.wrapper);

this.margin_panel.find('.btn-close-margin-panel, .nexus-margin-backdrop').on('click', () => {
    this.close_margin_panel();
});
	}

	_gen_trip_id() {
		return 'TRP-' + Date.now().toString(36).slice(-4).toUpperCase() + Math.random().toString(36).slice(2, 4).toUpperCase();
	}

	add_new_truck() {
		frappe.prompt([
			{ label: 'Truck Number', fieldname: 'truck_number', fieldtype: 'Data', reqd: 1 },
			{ label: 'Driver Name', fieldname: 'driver_name', fieldtype: 'Data' },
			{ label: 'Vehicle Type', fieldname: 'capacity_kg', fieldtype: 'Link', options: 'Vehicle Type', reqd: 1 },
		], (vals) => {
			const plate = (vals.truck_number || '').trim().toUpperCase();
			if (!plate) return;
			vals.truck_number = plate;

			const existing = this.available_trucks.find(t => t.truck_number === plate);
			if (existing) {
				// Same plate re-added — fetch all active orders from DB (authoritative, unaffected by UI filters)
				frappe.call({
					method: 'frappe.client.get_list',
					args: {
						doctype: 'Sales Order',
						fields: ['name', 'customer', 'customer_name', 'custom_delivery_region', 'grand_total', 'total_net_weight'],
						filters: [
							['Sales Order', 'custom_truck_number', '=', plate],
							['Sales Order', 'custom_truck_closed', '!=', 1],
						],
						limit_page_length: 0,
					},
					callback: (r) => {
						const truck_orders = r.message || [];
						if (truck_orders.length) {
							frappe.confirm(
								__('Truck {0} has {1} active order(s) from the current trip. Archive that trip and start a new one?', [plate, truck_orders.length]),
								() => {
									// Update driver/capacity before archiving so new trip inherits updated values
									existing.driver_name = vals.driver_name || existing.driver_name;
									existing.capacity_kg = vals.capacity_kg != null ? vals.capacity_kg : existing.capacity_kg;
									this._close_truck_batch(plate, truck_orders);
								}
							);
						} else {
							// No active orders — just reset trip and update meta
							existing.driver_name = vals.driver_name || existing.driver_name;
							existing.capacity_kg = vals.capacity_kg != null ? vals.capacity_kg : existing.capacity_kg;
							existing.trip_id = this._gen_trip_id();
							this._save_truck_meta();
							frappe.show_alert({ message: __('New trip started for {0} ({1})', [plate, existing.trip_id]), indicator: 'green' });
							this.render_view();
						}
					},
				});
			} else {
				// Brand new truck — add to active list then create a Draft CTP immediately
				vals.trip_id  = this._gen_trip_id();
				vals.plan_name = '';
				this.available_trucks.push(vals);
				this._save_truck_meta();
				frappe.show_alert({ message: __('Truck {0} added ({1})', [vals.truck_number, vals.trip_id]), indicator: 'green' });
				this.render_view();
				frappe.call({
					method: 'crystal_custom.crystal_customizations.page.sales_order_truck_as.sales_order_truck_as.create_active_truck_plan',
					args: {
						truck_number: plate,
						driver_name:  vals.driver_name || '',
						capacity_kg:  vals.capacity_kg || 5000,
						trip_id:      vals.trip_id,
					},
					callback: (r) => {
						if (r.message) {
							const idx = this.available_trucks.findIndex(t => t.truck_number === plate);
							if (idx >= 0) {
								this.available_trucks[idx].plan_name = r.message;
								this._save_truck_meta();
							}
						}
					},
				});
			}
		}, __('Add Truck'), __('Add'));
	}

	_fetch_fleet_settings() {
    frappe.call({
        method: 'crystal_custom.crystal_customizations.page.sales_order_truck_as.sales_order_truck_as.get_fleet_settings',
        callback: (r) => {
            if (r.message && r.message.narrowed_margin_profitability_threshold !== undefined) {
                const parsed = parseFloat(r.message.narrowed_margin_profitability_threshold);
                if (!isNaN(parsed)) this.profitability_threshold = parsed;
            }
        }
    });

}


open_margin_panel() {
    this.page.wrapper.find('.nexus-margin-panel').addClass('active');
    this.page.wrapper.find('.nexus-margin-backdrop').addClass('active');
}
close_margin_panel() {
    this.page.wrapper.find('.nexus-margin-panel, .nexus-margin-backdrop').removeClass('active');
}
	// ── Data loading ──────────────────────────────────────────────────────────

	load_trucks_from_orders() {
		// Load saved truck metadata first, then discover truck numbers from orders
		frappe.call({
			method: 'crystal_custom.crystal_customizations.page.sales_order_truck_as.sales_order_truck_as.get_truck_meta',
			callback: (meta_r) => {
				try {
					(JSON.parse(meta_r.message || '[]') || []).forEach(t => {
						this.saved_meta[t.truck_number] = t;
					});
				} catch(e) {}

				frappe.call({
					method: 'frappe.client.get_list',
					args: {
						doctype: 'Sales Order',
						fields: ['custom_truck_number'],
						filters: [
							['Sales Order', 'docstatus', 'in', [0, 1]],
							['Sales Order', 'custom_truck_number', '!=', ''],
							['Sales Order', 'custom_truck_closed', '!=', 1],
						],
						limit_page_length: 500,
					},
					callback: (r) => {
						if (r.message) {
							[...new Set(r.message.map(o => o.custom_truck_number).filter(Boolean))].forEach(t => {
								if (!this.available_trucks.find(x => x.truck_number === t)) {
									const m = this.saved_meta[t] || {};
									this.available_trucks.push({
										truck_number: t,
										driver_name:  m.driver_name  || '',
										capacity_kg:  m.capacity_kg  != null ? m.capacity_kg : 5000,
										trip_id:      m.trip_id      || this._gen_trip_id(),
										plan_name:    m.plan_name    || '',
									});
								}
							});
							if (this.available_trucks.some(t => !(this.saved_meta[t.truck_number] || {}).trip_id)) {
								this._save_truck_meta();
							}
						}
						// Recover any trucks that exist as Draft CTPs but are not in saved_meta
						frappe.call({
							method: 'crystal_custom.crystal_customizations.page.sales_order_truck_as.sales_order_truck_as.get_active_truck_plans',
							callback: (pr) => {
								let recovered = false;
								(pr.message || []).forEach(p => {
									const ex = this.available_trucks.find(t => t.truck_number === p.truck_number);
									if (ex) {
										if (!ex.plan_name) { ex.plan_name = p.name; recovered = true; }
									} else {
										this.available_trucks.push({
											truck_number: p.truck_number,
											driver_name:  p.driver_name || '',
											capacity_kg:  p.capacity_kg != null ? p.capacity_kg : 5000,
											trip_id:      p.trip_id     || this._gen_trip_id(),
											plan_name:    p.name,
										});
										recovered = true;
									}
								});
								if (recovered) this._save_truck_meta();

								// Load trip history from Crystal Truck Plans (primary) + legacy KV fallback
								frappe.call({
									method: 'crystal_custom.crystal_customizations.page.sales_order_truck_as.sales_order_truck_as.get_truck_history',
									callback: (hr) => {
										this.closed_trucks = hr.message || [];
										this.load_data();
									},
									error: () => this.load_data(),
								});
							},
							error: () => {
								frappe.call({
									method: 'crystal_custom.crystal_customizations.page.sales_order_truck_as.sales_order_truck_as.get_truck_history',
									callback: (hr) => { this.closed_trucks = hr.message || []; this.load_data(); },
									error: () => this.load_data(),
								});
							},
						});
					},
				});
			},
		});
	}

	load_data() {
		this.selected_orders.clear();
		this.selected_trucks.clear();
		this.container.html(this._loading_html());
		const from = this.page.fields_dict.from_date.get_value();
		const to   = this.page.fields_dict.to_date.get_value();

		frappe.call({
			method: 'crystal_custom.crystal_customizations.page.sales_order_truck_as.sales_order_truck_as.get_truck_assignment_orders',
			args: {
				from_date:           from || null,
				to_date:             to   || null,
				sales_persons_json:  this._sps.size ? JSON.stringify([...this._sps]) : null,
				regions_json:        this._regions.size ? JSON.stringify([...this._regions]) : null,
			},
			callback: (r) => {
				const result = r.message || { assigned: [], unassigned: [] };
				const truck_rows     = result.assigned   || [];
				const unassigned_rows = result.unassigned || [];

				// Merge: truck-assigned always win; add unassigned not already present
				const seen   = new Set(truck_rows.map(o => o.name));
				const merged = [...truck_rows, ...unassigned_rows.filter(o => !seen.has(o.name))];

				// Orphaned orders (from a closed truck) still carry their old truck number.
				// Clear it so they appear in the awaiting list rather than creating a ghost truck panel.
				merged.forEach(o => { if (o.orphaned_from_truck) o.custom_truck_number = ''; });

				this.orders = merged;

				// Seed any newly-seen truck numbers, restoring saved metadata
				let seeded_new_trip_id = false;
				this.orders.forEach(o => {
					if (o.custom_truck_number && !this.available_trucks.find(t => t.truck_number === o.custom_truck_number)) {
						const m = this.saved_meta[o.custom_truck_number] || {};
						const trip_id = m.trip_id || this._gen_trip_id();
						if (!m.trip_id) seeded_new_trip_id = true;
						this.available_trucks.push({
							truck_number: o.custom_truck_number,
							driver_name:  m.driver_name  || '',
							capacity_kg:  m.capacity_kg  != null ? m.capacity_kg : 5000,
							trip_id,
						});
					}
				});
				if (seeded_new_trip_id) this._save_truck_meta();

				// Fetch customer locations then render
				const customers = [...new Set(this.orders.map(o => o.customer).filter(Boolean))];
				if (!customers.length) {
					this._fetch_vehicle_capacities(() => { this.render_view(); });
					return;
				}
				frappe.call({
					method: 'frappe.client.get_list',
					args: {
						doctype: 'Customer',
						fields: ['name', 'custom_location'],
						filters: [['name', 'in', customers]],
						limit_page_length: customers.length,
					},
					callback: (rc) => {
						const loc_map = {};
						(rc.message || []).forEach(c => { loc_map[c.name] = c.custom_location || ''; });
						this.orders.forEach(o => { o.custom_location = loc_map[o.customer] || ''; });
						this._fetch_vehicle_capacities(() => { this.render_view(); });
					},
					error: () => { this._fetch_vehicle_capacities(() => { this.render_view(); }); },
				});
			},
			error: () => { this.render_view(); },
		});
	}

	get_filtered_orders() {
		let orders = this._regions.size
			? this.orders.filter(o => this._regions.has(o.custom_delivery_region))
			: this.orders;
		if (this.search_term) {
			const q = this.search_term.toLowerCase();
			orders = orders.filter(o =>
				(o.name          || '').toLowerCase().includes(q) ||
				(o.customer_name || '').toLowerCase().includes(q) ||
				(o.customer      || '').toLowerCase().includes(q) ||
				(o.sales_persons || '').toLowerCase().includes(q)
			);
		}
		return orders;
	}

	// ── Rendering ─────────────────────────────────────────────────────────────

	render_view() {
		const orders     = this.get_filtered_orders();
		const unassigned = orders.filter(o => !o.custom_truck_number);
		const assigned   = orders.filter(o => o.custom_truck_number);
		const total_val  = orders.reduce((s, o) => s + (o.grand_total || 0), 0);
		const trucks_used = new Set(assigned.map(o => o.custom_truck_number)).size;

		let html = `
		<div class="ta-kpi-row">
			${this._kpi('Total Orders',   orders.length,                '#667eea')}
			${this._kpi('Unassigned',     unassigned.length,            unassigned.length > 0 ? '#ef4444' : '#10b981')}
			${this._kpi('Assigned',       assigned.length,              '#10b981')}
			${this._kpi('Total Value',    format_currency(total_val),   '#f59e0b')}
			${this._kpi('Trucks Active',  trucks_used,                  '#8b5cf6')}
		</div>

		${(this.available_trucks.length || this.closed_trucks.length) ? `
		<div class="ta-section">
			<div class="ta-section-header">
				Trucks
				<span class="ta-count-badge">${trucks_used} loaded${this.closed_trucks.length ? ` &nbsp;·&nbsp; ${this.closed_trucks.length} trips today` : ''}</span>
			</div>
			${this.search_term ? this._render_search_truck_results(orders) : `
			<div class="ta-subtabs">
				<button class="ta-subtab-btn ${this.trucks_tab === 'active' ? 'active' : ''}" data-tab="active">
					Active
					<span class="ta-subtab-badge">${trucks_used}</span>
				</button>
				<button class="ta-subtab-btn ${this.trucks_tab === 'dispatched' ? 'active' : ''}" data-tab="dispatched">
					Trip History
					${this.closed_trucks.length ? `<span class="ta-subtab-badge" style="background:#64748b;">${this.closed_trucks.length}</span>` : ''}
				</button>
			</div>
			${this.trucks_tab === 'active' ? this._render_trucks(this.orders) : this._render_dispatched_trucks()}`}
		</div>` : ''}

		<div class="ta-section">
			<div class="ta-section-header">
				Orders Awaiting Assignment
				<span class="ta-count-badge">${unassigned.length}</span>
			</div>
			${this._render_awaiting(unassigned)}
		</div>

		${this._styles()}`;

		this.container.html(html);
		this._attach_events();
	}

	_save_truck_meta() {
		// Only persist trucks with current orders — prevents the metadata blob from
		// growing unboundedly as old trips accumulate across sessions.
		const active_nums = new Set(this.orders.map(o => o.custom_truck_number).filter(Boolean));
		const data = this.available_trucks
			.filter(t => active_nums.has(t.truck_number))
			.map(t => ({
				truck_number: t.truck_number,
				driver_name:  t.driver_name  || '',
				capacity_kg:  t.capacity_kg  != null ? t.capacity_kg : 5000,
				trip_id:      t.trip_id      || '',
				plan_name:    t.plan_name    || '',
			}));
		// Update in-memory saved_meta so subsequent seeds in load_data() use fresh values
		this.saved_meta = {};
		data.forEach(t => { this.saved_meta[t.truck_number] = t; });

		frappe.call({
			method: 'crystal_custom.crystal_customizations.page.sales_order_truck_as.sales_order_truck_as.save_truck_meta',
			args: { trucks_json: JSON.stringify(data) },
		});
	}

	_fetch_vehicle_capacities(done) {
		const vehicle_types = [...new Set(this.available_trucks.map(t => t.capacity_kg).filter(Boolean))];
		if (!vehicle_types.length) { if (done) done(); return; }
		frappe.call({
			method: 'frappe.client.get_list',
			args: {
				doctype: 'Vehicle Type',
				fields: ['name', 'max_tonnage'],
				filters: [['name', 'in', vehicle_types]],
				limit_page_length: vehicle_types.length,
			},
			callback: (r) => {
				(r.message || []).forEach(v => { this.vehicle_capacity_map[v.name] = v.max_tonnage || 0; });
				if (done) done();
			},
			error: () => { if (done) done(); },
		});
	}

	_kpi(label, value, color) {
		return `<div class="ta-kpi" style="border-top:4px solid ${color}">
			<div class="ta-kpi-label">${label}</div>
			<div class="ta-kpi-value" style="color:${color}">${value}</div>
		</div>`;
	}

	_loading_html() {
		return `<div style="text-align:center;padding:60px;" class="text-muted">
			<i class="fa fa-spinner fa-spin fa-2x"></i><br><br>Loading…
		</div>`;
	}

	_render_awaiting(all_orders) {
		if (!all_orders.length) {
			return '<div class="ta-empty">All orders have been assigned to trucks.</div>';
		}

		// Group by delivery region, sorted A-Z, unspecified last
		const groups = {};
		all_orders.forEach(o => {
			const key = o.custom_delivery_region || '__none__';
			if (!groups[key]) groups[key] = [];
			groups[key].push(o);
		});
		const sorted_keys = Object.keys(groups).sort((a, b) => {
			if (a === '__none__') return 1;
			if (b === '__none__') return -1;
			return a.localeCompare(b);
		});

		const truck_opts = this.available_trucks.map(t =>
			`<option value="${frappe.utils.escape_html(t.truck_number)}">`
		).join('');

		// Count selected orders visible in the full filtered list (all pages)
		const sel_orders  = all_orders.filter(o => this.selected_orders.has(o.name));
		const sel_count   = sel_orders.length;
		const all_checked = all_orders.length > 0 && sel_count === all_orders.length;
		const sel_weight  = sel_orders.reduce((s, o) => s + (o.total_net_weight || 0), 0);
		const sel_value   = sel_orders.reduce((s, o) => s + (o.grand_total      || 0), 0);

		let html = `
		<datalist id="ta-trucks-list">${truck_opts}</datalist>

		<div class="ta-bulk-bar">
			<label class="ta-bulk-select-label">
				<input type="checkbox" class="ta-select-all-chk" ${all_checked ? 'checked' : ''}>
				Select all
			</label>
			<span class="ta-bulk-sep"></span>
			<span class="ta-bulk-count">${sel_count} of ${all_orders.length} selected</span>
			${sel_count ? `
			<span class="ta-bulk-sel-stats">
				<span class="ta-bulk-sel-stat" title="Total weight of selected orders">&#8981; ${sel_weight.toFixed(1)} kg</span>
				<span class="ta-bulk-sel-stat" title="Total value of selected orders">${format_currency(sel_value, null, 0)}</span>
			</span>` : ''}
			<div class="ta-bulk-actions" style="align-items: center; gap: 8px;">
				<label class="ta-bulk-select-label" style="font-weight: normal; font-size: 12px;" title="Combine selected awaiting orders with orders already assigned to this truck">
					<input type="checkbox" class="ta-include-current-chk" disabled style="width:14px; height:14px; accent-color:#667eea; cursor:pointer;">
					Include Truck's Current Load
				</label>
				<button class="btn btn-sm btn-outline-dark btn-analyse-margins-awaiting" title="Analyse Margins for selected orders" ${!sel_count ? 'disabled' : ''}>
					Analyse Margins
				</button>
				<button class="btn btn-sm btn-black-action btn-optimize-awaiting" title="Optimize Route for selected orders" ${!sel_count ? 'disabled' : ''}>
					Optimize Route
				</button>
				<div style="width: 1px; height: 20px; background-color: #cbd5e1; margin: 0 4px;"></div>
				<input type="text" class="ta-bulk-truck-input form-control form-control-sm"
				       list="ta-trucks-list" placeholder="Assign to truck…"
				       ${!sel_count ? 'disabled' : ''}>
				<button class="btn btn-sm btn-primary ta-bulk-assign-btn" ${!sel_count ? 'disabled' : ''}>
					Assign
				</button>
				${sel_count ? `<button class="btn btn-sm btn-default ta-bulk-clear-btn">Clear</button>` : ''}
			</div>
		</div>

		<div class="ta-table-wrap">
		<table class="table table-bordered ta-table">
			<thead><tr>
				<th width="3%"></th>
				<th width="11%">Sales Order</th>
				<th width="12%">Customer</th>
				<th width="9%">Location</th>
				<th width="7%">Region</th>
				<th width="7%">Value</th>
				<th width="6%">Weight</th>
				<th width="8%">Status</th>
				<th width="12%">Assign Truck</th>
				<th width="7%">Pre-Fulfilment</th>
			</tr></thead>
			<tbody>`;

		sorted_keys.forEach(key => {
			const label   = key === '__none__' ? 'No Region' : key;
			const grp     = groups[key];
			const grp_val = grp.reduce((s, o) => s + (o.grand_total || 0), 0);

			html += `<tr class="ta-group-row">
				<td colspan="10">
					<strong>${label}</strong>
					<span class="ta-group-meta">${grp.length} order${grp.length !== 1 ? 's' : ''} &nbsp;·&nbsp; ${format_currency(grp_val)}</span>
				</td>
			</tr>`;

			// Sort: overdue → orphan (needs reassign) → submitted-needs-truck → normal
			const _today = frappe.datetime.get_today();
			grp.sort((a, b) => {
				const _overdue   = o => o.delivery_date && o.delivery_date < _today && !parseFloat(o.per_delivered) && !parseFloat(o.per_billed);
				const _orphan    = o => !!(o.orphaned_from_truck);
				const _submitted = o => parseInt(o.docstatus) === 1;
				const rank = o => _overdue(o) ? 0 : _orphan(o) ? 1 : _submitted(o) ? 2 : 3;
				return rank(a) - rank(b);
			});

			grp.forEach(o => {
				const not_picked    = o.custom_call_not_picked === 1;
				const checked       = this.selected_orders.has(o.name);
				const is_pf         = o.custom_is_pre_fulfillment == 1;
				const is_submitted  = parseInt(o.docstatus) === 1;
				const is_orphan     = !!(o.orphaned_from_truck);   // had a truck, truck closed, not delivered
				const today         = frappe.datetime.get_today();
				const is_overdue    = o.delivery_date && o.delivery_date < today
					&& !parseFloat(o.per_delivered || 0)
					&& !parseFloat(o.per_billed    || 0);
				html += `
				<tr class="ta-row${checked ? ' ta-row-selected' : ''}${is_pf ? ' ta-row-pf' : ''}" data-order="${o.name}">
					<td class="ta-td-chk">
						<input type="checkbox" class="ta-order-chk" data-order="${o.name}" ${checked ? 'checked' : ''}>
					</td>
					<td>
						<a href="/app/sales-order/${o.name}" target="_blank">${o.name}</a>
						${not_picked ? '<span class="ta-warn-badge" title="Call not picked">!</span>' : ''}
						${is_orphan ? `<div style="font-size:10px;color:#b45309;margin-top:1px;">Prev truck: ${frappe.utils.escape_html(o.orphaned_from_truck)}</div>` : ''}
						${is_submitted && o.delivery_date && !is_overdue && !is_orphan ? `<div style="font-size:10px;color:#7c3aed;margin-top:1px;">Due: ${frappe.datetime.str_to_user(o.delivery_date)}</div>` : ''}
					</td>
					<td title="${frappe.utils.escape_html(o.customer)}">
						<div style="display:flex; justify-content:space-between; align-items:center;">
							<span>${frappe.utils.escape_html(o.customer_name || o.customer)}</span>
							${(o.custom_latitude && o.custom_longitude && parseFloat(o.custom_latitude) !== 0 && parseFloat(o.custom_longitude) !== 0)
								? `<span class="ta-gps-badge ta-gps-mapped" title="GPS Available">&#10003; Mapped</span>`
								: `<span class="ta-gps-badge ta-gps-missing" title="No GPS Coordinates">No GPS</span>`}
						</div>
						${not_picked && o.custom_call_notes ? `<small class="ta-note">${frappe.utils.escape_html(o.custom_call_notes)}</small>` : ''}
					</td>
					<td>${o.custom_location ? frappe.utils.escape_html(o.custom_location) : '<span class="text-muted">—</span>'}</td>
					<td>${o.custom_delivery_region || '—'}</td>
					<td class="ta-amt">${format_currency(o.grand_total)}</td>
					<td class="ta-amt">${(o.total_net_weight || 0).toFixed(1)} kg</td>
					<td>${this._state_badge(o.workflow_state)}</td>
					<td>
						<input type="text"
							   class="ta-truck-input form-control form-control-sm"
							   list="ta-trucks-list"
							   placeholder="Truck number…"
							   data-order="${o.name}"
							   value="${frappe.utils.escape_html(o.custom_truck_number || '')}">
					</td>
					<td style="text-align:center;">
						<button class="btn btn-xs ta-pf-btn"
						        data-order="${o.name}" data-pf="${is_pf ? 1 : 0}"
						        title="${is_pf ? 'Pre-Fulfilment — click to remove' : 'Mark as Pre-Fulfilment'}"
						        style="${is_pf ? 'background:#0d9488;color:#fff;border-color:#0d9488;' : 'background:#f1f5f9;color:#64748b;border-color:#cbd5e1;'}">
							${is_pf ? '&#128205; On' : 'Off'}
						</button>
					</td>
				</tr>`;
			});
		});

		html += `</tbody></table>
		</div>`;
		return html;
	}

	_state_badge(state) {
		const map = {
			'Pending Finance Approval':              ['#f59e0b', 'Finance'],
			'Pending Customer Order Reconfirmation': ['#3b82f6', 'Confirming'],
			'Order Confirmed':                       ['#10b981', 'Confirmed'],
		};
		const [color, label] = map[state] || ['#9ca3af', state || '—'];
		return `<span class="ta-state-badge" style="background:${color}">${label}</span>`;
	}

	_render_search_truck_results(matched_orders) {
		const assigned_matches = matched_orders.filter(o => o.custom_truck_number);
		if (!assigned_matches.length) return '<div class="ta-empty">No assigned orders match this search.</div>';

		// Build a map of truck_number → truck meta (active + dispatched)
		const all_truck_meta = {};
		this.available_trucks.forEach(t => { all_truck_meta[t.truck_number] = t; });
		this.closed_trucks.forEach(t => { all_truck_meta[t.truck_number] = t; });
		const closed_set = new Set(this.closed_trucks.map(t => t.truck_number));

		const truck_numbers = [...new Set(assigned_matches.map(o => o.custom_truck_number))];
		let html = '<div class="ta-trucks-grid">';
		truck_numbers.forEach(tn => {
			const truck = all_truck_meta[tn] || { truck_number: tn };
			const is_dispatched = closed_set.has(tn);
			const truck_orders = assigned_matches.filter(o => o.custom_truck_number === tn);
			const total_weight = truck_orders.reduce((s, o) => s + (o.total_net_weight || 0), 0);
			const total_value  = truck_orders.reduce((s, o) => s + (o.grand_total || 0), 0);
			html += `
			<div class="ta-truck-card" style="${is_dispatched ? 'opacity:0.75;border-top:4px solid #64748b;' : ''}">
				<div class="ta-truck-head">
					<div class="ta-truck-num">${frappe.utils.escape_html(tn)}
						${is_dispatched ? '<span style="font-size:10px;font-weight:400;color:#64748b;margin-left:6px;">Dispatched</span>' : ''}
					</div>
				</div>
				${truck.driver_name ? `<div class="ta-truck-driver">${frappe.utils.escape_html(truck.driver_name)}</div>` : ''}
				<div class="ta-truck-stats">
					<div class="ta-truck-stat"><span>${truck_orders.length}</span>Matched Orders</div>
					<div class="ta-truck-stat"><span>${total_weight.toFixed(0)} kg</span>Weight</div>
					<div class="ta-truck-stat"><span>${format_currency(total_value, null, 0)}</span>Value</div>
				</div>
				<div class="ta-truck-orders">
					${truck_orders.map(o => `
					<div class="ta-truck-order" style="background:#fef9c3;">
						<div>
							<a href="/app/sales-order/${o.name}" target="_blank" class="ta-order-link">${o.name}</a>
							<span class="ta-order-cust">${frappe.utils.escape_html(o.customer_name || o.customer)}</span>
						</div>
						<div style="font-size:11px;color:#64748b;">${frappe.utils.escape_html(o.custom_delivery_region || '')}</div>
					</div>`).join('')}
				</div>
			</div>`;
		});
		html += '</div>';
		return html;
	}

	_render_trucks(all_orders) {
		// Only show trucks that currently have orders — stale/empty trucks are hidden.
		const active_trucks = this.available_trucks.filter(t =>
			all_orders.some(o => o.custom_truck_number === t.truck_number)
		);
		if (!active_trucks.length) return '';

		// Truck bulk action bar — always visible so "select all" is always accessible
		const sel_t      = this.selected_trucks.size;
		const all_t      = active_trucks.length;
		const all_t_checked = sel_t === all_t && all_t > 0;

		const sel_truck_objs = active_trucks.filter(t => this.selected_trucks.has(t.truck_number));
		const sel_t_orders   = all_orders.filter(o => o.custom_truck_number && this.selected_trucks.has(o.custom_truck_number));
		const sel_t_weight   = sel_truck_objs.reduce((s, t) => {
			return s + all_orders.filter(o => o.custom_truck_number === t.truck_number).reduce((ws, o) => ws + (o.total_net_weight || 0), 0);
		}, 0);
		const sel_t_value = sel_t_orders.reduce((s, o) => s + (o.grand_total || 0), 0);

		let html = `
		<div class="ta-truck-bulk-bar">
			<label class="ta-bulk-select-label" title="Select all trucks">
				<input type="checkbox" class="ta-select-all-trucks-chk" ${all_t_checked ? 'checked' : ''}>
				Select all
			</label>
			<span class="ta-bulk-sep"></span>
			<span class="ta-truck-bulk-info">${sel_t} of ${all_t} truck${all_t !== 1 ? 's' : ''} selected
				${sel_t ? `&nbsp;·&nbsp; &#8981; ${sel_t_weight.toFixed(0)} kg &nbsp;·&nbsp; ${format_currency(sel_t_value, null, 0)}` : ''}
			</span>
			${sel_t ? `
			<div style="display:flex;gap:6px;margin-left:auto;">
				<button class="btn btn-sm btn-primary ta-bulk-dispatch-trucks">Dispatch Selected</button>
				<button class="btn btn-sm btn-danger  ta-bulk-remove-trucks">Remove Selected</button>
				<button class="btn btn-sm btn-default ta-bulk-clear-trucks">Clear</button>
			</div>` : ''}
		</div>`;

		html += '<div class="ta-trucks-grid">';

		active_trucks.forEach(truck => {
			const truck_orders = all_orders.filter(o => o.custom_truck_number === truck.truck_number);
			const total_weight = truck_orders.reduce((s, o) => s + (o.total_net_weight || 0), 0);
			const total_value  = truck_orders.reduce((s, o) => s + (o.grand_total || 0), 0);
			const capacity     = this.vehicle_capacity_map[truck.capacity_kg] || 0;
			const cap_pct      = capacity > 0 ? Math.min((total_weight / capacity) * 100, 100).toFixed(0) : 0;
			const is_empty     = !truck_orders.length;
			const not_picked   = truck_orders.filter(o => o.custom_call_not_picked === 1).length;
			const regions      = [...new Set(truck_orders.map(o => o.custom_delivery_region).filter(Boolean))].sort();
			const is_checked   = this.selected_trucks.has(truck.truck_number);

			// Warehouse status badge — falls back to "Pending Loading" when the
			// backend hasn't supplied warehouse_status (older get_active_trucks
			// responses), so the badge always renders something sensible.
			const wh_status  = truck.warehouse_status || 'Pending';
			const is_loaded  = wh_status === 'Loaded';
			const status_badge = `<span class="ta-status-badge ${is_loaded ? 'loaded' : 'pending'}">${is_loaded ? 'Ready for Dispatch' : 'Pending Loading'}</span>`;

			html += `
			<div class="ta-truck-card${is_empty ? ' ta-truck-empty' : ''}${is_checked ? ' ta-truck-selected' : ''}">
				<div class="ta-card-header">
					<div class="ta-truck-head">
						<label class="ta-truck-chk-wrap" title="Select truck">
							<input type="checkbox" class="ta-truck-chk" data-truck="${frappe.utils.escape_html(truck.truck_number)}" ${is_checked ? 'checked' : ''}>
						</label>
						<div class="ta-truck-title-row">
							<span class="ta-truck-num">${frappe.utils.escape_html(truck.truck_number)}</span>
							${status_badge}
						</div>
					</div>
					${truck.trip_id ? `<div class="ta-trip-id">${frappe.utils.escape_html(truck.trip_id)}</div>` : ''}

					${truck.driver_name ? `<div class="ta-truck-driver"><i class="fa fa-user" style="color:#94a3b8;"></i>${frappe.utils.escape_html(truck.driver_name)}</div>` : ''}
					${not_picked ? `<div class="ta-truck-warn">${not_picked} customer(s) did not answer — driver should contact on arrival</div>` : ''}

					${!is_empty ? `
					<div class="ta-truck-stats">
						<div class="ta-truck-stat"><span>${truck_orders.length}</span>Orders</div>
						<div class="ta-truck-stat"><span>${total_weight.toFixed(0)} kg</span>Weight</div>
						<div class="ta-truck-stat"><span>${format_currency(total_value, null, 0)}</span>Value</div>
					</div>
					${capacity > 0 ? `
					<div class="ta-cap-bar">
						<div class="ta-cap-fill" style="width:${cap_pct}%;background:${cap_pct > 90 ? '#ef4444' : '#10b981'}"></div>
					</div>
					<div class="ta-cap-label">${cap_pct}% capacity (${total_weight.toFixed(0)} / ${capacity} kg)</div>
					` : ''}
					${regions.length ? `<div class="ta-truck-routes">${regions.map(r => `<span class="ta-route-tag"><i class="fa fa-map-marker"></i> ${r}</span>`).join('')}</div>` : ''}
					` : '<div class="ta-empty-truck">No orders assigned</div>'}

					<div class="ta-truck-btns-container">
						${!is_empty ? `
						<div class="ta-truck-actions-primary">
							<span class="ta-analyse-margins-link btn-analyse-margins-truck" data-truck="${truck.truck_number}">Analyse Margins</span>
							<button class="btn btn-sm btn-black-action btn-optimize-truck" data-truck="${truck.truck_number}">Optimize Route</button>
							<button class="btn btn-sm btn-black-action btn-close-truck" data-truck="${truck.truck_number}">Dispatch</button>
						</div>` : ''}
						<div class="ta-truck-actions-icons">
							<button class="btn btn-xs btn-default btn-dl-manifest"   data-truck="${truck.truck_number}" title="Download manifest"><i class="fa fa-download"></i></button>
							<button class="btn btn-xs btn-default btn-edit-truck"    data-truck="${truck.truck_number}" title="Edit"><i class="fa fa-pencil"></i></button>
							${!is_empty ? `<button class="btn btn-xs btn-default btn-reassign-truck" data-truck="${truck.truck_number}" title="Move all orders to another truck"><i class="fa fa-exchange"></i></button>` : ''}
							<button class="btn btn-xs btn-danger  btn-delete-truck"  data-truck="${truck.truck_number}" title="${is_empty ? 'Remove truck' : 'Unassign all orders'}"><i class="fa fa-trash"></i></button>
						</div>
					</div>
				</div>

				${!is_empty ? `
				<div class="ta-card-orders-section">
					<div class="ta-orders-header">Assigned Orders</div>
					<div class="ta-truck-orders">
						${truck_orders.map(o => {
							const is_done = o.so_status === 'Completed' || o.so_status === 'Closed';
							return `
						<div class="ta-truck-order${is_done ? ' ta-order-invoiced' : ''}">
							<div>
								<div style="display:flex; justify-content:space-between; align-items:center;">
									<a href="/app/sales-order/${o.name}" target="_blank" class="ta-order-link">${o.name}</a>
									${(o.custom_latitude && o.custom_longitude && parseFloat(o.custom_latitude) !== 0 && parseFloat(o.custom_longitude) !== 0)
										? `<span style="color:#10b981;font-size:10px;font-weight:600;">&#10003; Mapped</span>`
										: `<span style="color:#94a3b8;font-size:10px;">No GPS</span>`}
								</div>
								<span class="ta-order-cust">${frappe.utils.escape_html(o.customer_name || o.customer)}</span>
								${o.custom_location ? `<span class="ta-order-loc">${frappe.utils.escape_html(o.custom_location)}</span>` : ''}
								${is_done ? '<span class="ta-invoiced-badge">Invoiced</span>' : ''}
							</div>
							${!is_done ? `<button class="btn btn-xs btn-default btn-unassign" data-order="${o.name}" title="Remove from truck">&#215;</button>` : ''}
						</div>`;
						}).join('')}
					</div>
				</div>` : ''}
			</div>`;
		});

		html += '</div>';
		return html;
	}

	_render_dispatched_trucks() {
		if (!this.closed_trucks.length) {
			return `<div style="padding:24px;text-align:center;color:#94a3b8;">No trips recorded yet.</div>`;
		}

		let html = '<div class="ta-trucks-grid">';

		this.closed_trucks.forEach((ct, idx) => {
			const closed_label = ct.closed_at
				? frappe.datetime.str_to_user(ct.closed_at.split(' ')[0]) + ' ' + (ct.closed_at.split(' ')[1] || '').slice(0, 5)
				: '—';

			const order_rows = (ct.orders || []).map(o => `
			<div class="ta-truck-order">
				<div>
					<a href="/app/sales-order/${o.name}" target="_blank" class="ta-order-link">${frappe.utils.escape_html(o.name)}</a>
					<span class="ta-order-cust">${frappe.utils.escape_html(o.customer_name || '')}</span>
					${o.delivery_region ? `<span class="ta-order-loc">${frappe.utils.escape_html(o.delivery_region)}</span>` : ''}
				</div>
			</div>`).join('');

			html += `
			<div class="ta-truck-card ta-closed-card">
				<div class="ta-truck-head" style="background:#475569;">
					<div>
						<div class="ta-truck-num">&#10003; ${frappe.utils.escape_html(ct.truck_number)}</div>
						${ct.driver_name ? `<div class="ta-truck-driver" style="color:#cbd5e1;">${frappe.utils.escape_html(ct.driver_name)}</div>` : ''}
						${ct.trip_id ? `<div style="font-size:10px;color:#94a3b8;letter-spacing:.5px;">${frappe.utils.escape_html(ct.trip_id)}</div>` : ''}
					</div>
					<div style="text-align:right;">
						<div style="font-size:11px;color:#94a3b8;">${frappe.utils.escape_html(closed_label)}</div>
					</div>
				</div>

				<div class="ta-truck-stats">
					<div class="ta-truck-stat"><span>${ct.order_count}</span>Orders</div>
					<div class="ta-truck-stat"><span>${(ct.total_weight || 0).toFixed(0)} kg</span>Weight</div>
					<div class="ta-truck-stat"><span>${format_currency(ct.total_value || 0, null, 0)}</span>Value</div>
				</div>

				<div class="ta-orders-section">
					<div class="ta-closed-toggle" data-idx="${idx}">
						&#9658; View ${(ct.orders || []).length} order${(ct.orders || []).length !== 1 ? 's' : ''}
					</div>
					<div class="ta-closed-orders-list" id="ta-closed-orders-${idx}" style="display:none;">
						${order_rows}
					</div>
				</div>
			</div>`;
		});

		html += '</div>';
		return html;
	}

	// ── Events ────────────────────────────────────────────────────────────────

	_attach_events() {
		const self = this;

		// ── Bulk selection ────────────────────────────────────────────────────────

		// Select all (across all pages of filtered unassigned orders)
		this.container.find('.ta-select-all-chk').on('change', function () {
			const checked    = $(this).is(':checked');
			const unassigned = self.get_filtered_orders().filter(o => !o.custom_truck_number);
			unassigned.forEach(o => checked ? self.selected_orders.add(o.name) : self.selected_orders.delete(o.name));
			self.render_view();
		});

		// Trucks sub-tab switching (Active / Dispatched)
		this.container.off('click.ta-stab').on('click.ta-stab', '.ta-subtab-btn', function () {
			self.trucks_tab = $(this).data('tab');
			self.render_view();
		});

		// Individual row checkbox — update in place, no full re-render
		this.container.find('.ta-order-chk').on('change', function () {
			const name    = $(this).data('order');
			const checked = $(this).is(':checked');
			checked ? self.selected_orders.add(name) : self.selected_orders.delete(name);

			$(this).closest('tr').toggleClass('ta-row-selected', checked);

			// Update count label, weight/value summary, and button state
			const unassigned  = self.get_filtered_orders().filter(o => !o.custom_truck_number);
			const sel_orders  = unassigned.filter(o => self.selected_orders.has(o.name));
			const sel_count   = sel_orders.length;
			const all_checked = sel_count === unassigned.length && unassigned.length > 0;
			const sel_weight  = sel_orders.reduce((s, o) => s + (o.total_net_weight || 0), 0);
			const sel_value   = sel_orders.reduce((s, o) => s + (o.grand_total      || 0), 0);

			self.container.find('.ta-select-all-chk').prop('checked', all_checked);
			self.container.find('.ta-bulk-count').text(`${sel_count} of ${unassigned.length} selected`);
			self.container.find('.ta-bulk-assign-btn').prop('disabled', sel_count === 0);
			self.container.find('.ta-bulk-truck-input').prop('disabled', sel_count === 0);
			self.container.find('.btn-optimize-awaiting').prop('disabled', sel_count === 0);
			self.container.find('.btn-analyse-margins-awaiting').prop('disabled', sel_count === 0);

			// Update or remove the weight/value summary block
			self.container.find('.ta-bulk-sel-stats').remove();
			if (sel_count > 0) {
				const stats_html = `<span class="ta-bulk-sel-stats">
					<span class="ta-bulk-sel-stat" title="Total weight">&#8981; ${sel_weight.toFixed(1)} kg</span>
					<span class="ta-bulk-sel-stat" title="Total value">${format_currency(sel_value, null, 0)}</span>
				</span>`;
				self.container.find('.ta-bulk-count').after(stats_html);
			}

			// Show/hide Clear button
			if (sel_count > 0 && !self.container.find('.ta-bulk-clear-btn').length) {
				self.container.find('.ta-bulk-assign-btn').after(
					'<button class="btn btn-sm btn-default ta-bulk-clear-btn" style="margin-left:6px">Clear</button>'
				);
				self.container.find('.ta-bulk-clear-btn').on('click', () => {
					self.selected_orders.clear();
					self.render_view();
				});
			} else if (sel_count === 0) {
				self.container.find('.ta-bulk-clear-btn').remove();
			}
		});

		// Bulk assign button
		this.container.find('.ta-bulk-assign-btn').on('click', function () {
			const truck_number = self.container.find('.ta-bulk-truck-input').val().trim();
			if (!truck_number) {
				frappe.msgprint(__('Enter a truck number to assign to.'));
				return;
			}
			self._bulk_assign(truck_number);
		});

		// Bulk truck input: also trigger assign on Enter
		this.container.find('.ta-bulk-truck-input').on('keydown', function (e) {
			if (e.key === 'Enter') self.container.find('.ta-bulk-assign-btn').trigger('click');
		});

		// Clear button (rendered when sel_count > 0 at render time)
		this.container.find('.ta-bulk-clear-btn').on('click', function () {
			self.selected_orders.clear();
			self.render_view();
		});

		// ── Per-row truck assignment ───────────────────────────────────────────────

		// Truck assignment via text input (on change / blur)
		this.container.find('.ta-truck-input').off('change').on('change', function () {
			const order_name   = $(this).data('order');
			const truck_number = $(this).val().trim();
			if (truck_number && !self.available_trucks.find(t => t.truck_number === truck_number)) {
				const m = self.saved_meta[truck_number] || {};
				self.available_trucks.push({
					truck_number,
					driver_name: m.driver_name || '',
					capacity_kg: m.capacity_kg != null ? m.capacity_kg : 5000,
					trip_id:     m.trip_id     || self._gen_trip_id(),
				});
			}
			self._set_truck(order_name, truck_number);
		});

		// Also assign on Enter key
		this.container.find('.ta-truck-input').off('keydown').on('keydown', function (e) {
			if (e.key === 'Enter') $(this).trigger('change');
		});


		this.container.find('.btn-unassign').off('click').on('click', function () {
			self._set_truck($(this).data('order'), '');
		});

		this.container.find('.btn-edit-truck').off('click').on('click', function () {
			self.edit_truck_details($(this).data('truck'));
		});

		this.container.find('.btn-reassign-truck').off('click').on('click', function () {
			self.reassign_truck_orders($(this).data('truck'));
		});

		this.container.find('.btn-delete-truck').off('click').on('click', function () {
			self.delete_truck($(this).data('truck'));
		});

		this.container.find('.btn-close-truck').off('click').on('click', function () {
			self.close_truck($(this).data('truck'));
		});

		// ── Truck multi-select ────────────────────────────────────────────────────
		// Select all trucks checkbox
		this.container.find('.ta-select-all-trucks-chk').off('change').on('change', function () {
			const checked = $(this).is(':checked');
			const orders  = self.get_filtered_orders();
			const active_trucks = self.available_trucks.filter(t =>
				orders.some(o => o.custom_truck_number === t.truck_number)
			);
			active_trucks.forEach(t => checked ? self.selected_trucks.add(t.truck_number) : self.selected_trucks.delete(t.truck_number));
			self.render_view();
		});

		this.container.find('.ta-truck-chk').off('change').on('change', function () {
			const tn = $(this).data('truck');
			if ($(this).is(':checked')) self.selected_trucks.add(tn);
			else self.selected_trucks.delete(tn);
			// Update card highlight without full re-render
			$(this).closest('.ta-truck-card').toggleClass('ta-truck-selected', $(this).is(':checked'));
			// Re-render only the bulk bar area
			self.render_view();
		});

		this.container.find('.ta-bulk-clear-trucks').off('click').on('click', () => {
			self.selected_trucks.clear();
			self.render_view();
		});

		this.container.find('.ta-bulk-dispatch-trucks').off('click').on('click', () => {
			const trucks = [...self.selected_trucks];
			if (!trucks.length) return;
			frappe.confirm(
				__('Dispatch {0} truck(s)? Their orders will be recorded in Trip Plans and the trucks will be ready for the next load.', [trucks.length]),
				() => {
					self.selected_trucks.clear();

					// Dispatch trucks one at a time, calling load_data() only once at the very end.
					let idx = 0;
					const dispatch_next = () => {
						if (idx >= trucks.length) {
							// All trucks done — refresh history then reload once
							frappe.call({
								method: 'crystal_custom.crystal_customizations.page.sales_order_truck_as.sales_order_truck_as.get_truck_history',
								callback: (hr) => { self.closed_trucks = hr.message || []; self.load_data(); },
								error:    () => self.load_data(),
							});
							return;
						}
						const tn = trucks[idx++];
						const truck_orders = self.orders.filter(o => o.custom_truck_number === tn);
						if (truck_orders.length) {
							self.download_manifest(tn);
							self._close_truck_batch(tn, truck_orders, dispatch_next);
						} else {
							dispatch_next();
						}
					};
					dispatch_next();
				}
			);
		});

		this.container.find('.ta-bulk-remove-trucks').off('click').on('click', () => {
			const trucks = [...self.selected_trucks];
			if (!trucks.length) return;
			const total_orders = trucks.reduce((s, tn) => s + self.orders.filter(o => o.custom_truck_number === tn).length, 0);
			const msg = total_orders
				? __('Remove {0} truck(s) and unassign {1} order(s)? Orders will return to the unassigned list.', [trucks.length, total_orders])
				: __('Remove {0} empty truck(s)?', [trucks.length]);
			frappe.confirm(msg, () => {
				self.selected_trucks.clear();
				trucks.forEach(tn => {
					const truck_orders = self.orders.filter(o => o.custom_truck_number === tn);
					if (truck_orders.length) {
						self._set_truck_batch(truck_orders, '');
					} else {
						self.available_trucks = self.available_trucks.filter(t => t.truck_number !== tn);
					}
				});
				self._save_truck_meta();
				self.render_view();
			});
		});

		this.container.find('.btn-dl-manifest').off('click').on('click', function () {
			self.download_manifest($(this).data('truck'));
		});

		// Closed truck order list toggle
		this.container.off('click.ta-closed').on('click.ta-closed', '.ta-closed-toggle', function () {
			const idx   = $(this).data('idx');
			const $list = $(`#ta-closed-orders-${idx}`);
			const open  = $list.is(':visible');
			$list.slideToggle(150);
			const ct = self.closed_trucks[idx] || {};
			const n  = (ct.orders || []).length;
			$(this).html(`${open ? '&#9658;' : '&#9660;'} View ${n} order${n !== 1 ? 's' : ''}`);
		});

		this.container.find('.ta-pf-btn').off('click').on('click', function () {
			const $btn    = $(this);
			const order   = $btn.data('order');
			const cur_pf  = parseInt($btn.data('pf'), 10);
			const new_val = cur_pf ? 0 : 1;
			frappe.call({
				method: 'crystal_custom.crystal_customizations.page.sales_order_truck_as.sales_order_truck_as.set_pre_fulfillment',
				args: { order_name: order, value: new_val },
				callback: () => {
					const o = self.orders.find(x => x.name === order);
					if (o) o.custom_is_pre_fulfillment = new_val;
					$btn.data('pf', new_val);
					if (new_val) {
						$btn.css({ background: '#0d9488', color: '#fff', 'border-color': '#0d9488' })
						    .attr('title', 'Pre-Fulfilment — click to remove')
						    .html('&#128205; On');
						$btn.closest('tr').addClass('ta-row-pf');
					} else {
						$btn.css({ background: '#f1f5f9', color: '#64748b', 'border-color': '#cbd5e1' })
						    .attr('title', 'Mark as Pre-Fulfilment')
						    .html('Off');
						$btn.closest('tr').removeClass('ta-row-pf');
					}
					frappe.show_alert({
						message: new_val ? __('Marked as Pre-Fulfilment') : __('Pre-Fulfilment removed'),
						indicator: new_val ? 'green' : 'blue',
					});
				},
			});
		});

		// ── Dynamic checkbox toggle / re-optimize on truck-input change ──────────────
		this.container.find('.ta-bulk-truck-input').off('input.chk-toggle').on('input.chk-toggle', function() {
			const hasVal = $(this).val().trim().length > 0;
			const $chk = self.container.find('.ta-include-current-chk');
			$chk.prop('disabled', !hasVal);
			if (!hasVal) {
				const wasChecked = $chk.prop('checked');
				$chk.prop('checked', false);
				if (wasChecked && self.page.wrapper.find('.nexus-route-panel').hasClass('active')) {
					self.container.find('.btn-optimize-awaiting').trigger('click');
				}
			}
		});
		this.container.find('.ta-include-current-chk').off('change.chk-reopt').on('change.chk-reopt', function() {
			if (self.page.wrapper.find('.nexus-route-panel').hasClass('active')) {
				self.container.find('.btn-optimize-awaiting').trigger('click');
			}
		});

		// ── Route Optimization Buttons ──────────────────────────────────────────────

		this.container.find('.btn-optimize-awaiting').off('click').on('click', () => {
			const unassigned = this.get_filtered_orders().filter(o => !o.custom_truck_number);
			let selected_orders_data = unassigned.filter(o => this.selected_orders.has(o.name));
			const truck_input_val = this.container.find('.ta-bulk-truck-input').val().trim();
			const include_current = this.container.find('.ta-include-current-chk').is(':checked');
			if (include_current && truck_input_val) {
				const current_truck_orders = this.orders.filter(o => o.custom_truck_number === truck_input_val);
				const selectedNames = new Set(selected_orders_data.map(o => o.name));
				selected_orders_data = [...selected_orders_data, ...current_truck_orders.filter(o => !selectedNames.has(o.name))];
			}
			const truck_info = this.available_trucks.find(t => t.truck_number === truck_input_val);
			this.open_route_optimizer('Pre-Analysis: Awaiting Orders', selected_orders_data,
				truck_info ? truck_info.capacity_kg : null, truck_input_val || null);
		});

		this.container.find('.btn-optimize-truck').off('click').on('click', (e) => {
			const tn = $(e.currentTarget).data('truck');
			const truck_orders = this.orders.filter(o => o.custom_truck_number === tn);
			const truck_info = this.available_trucks.find(t => t.truck_number === tn);

			// Merge in any orders currently checked in the Awaiting Orders table —
			// lets a manager tick a few unassigned orders, then click Optimize
			// Route on an existing truck card to preview them combined with that
			// truck's current load, without having to assign them first.
			const unassigned = this.get_filtered_orders().filter(o => !o.custom_truck_number);
			const checked_unassigned = unassigned.filter(o => this.selected_orders.has(o.name));
			const truck_order_names = new Set(truck_orders.map(o => o.name));
			const combined_orders = [
				...truck_orders,
				...checked_unassigned.filter(o => !truck_order_names.has(o.name))
			];

			this.open_route_optimizer(`Active Route: ${tn}`, combined_orders, truck_info ? truck_info.capacity_kg : null, tn);
		});

		// ── Margin Analysis Buttons ──────────────────────────────────────────────────

		this.container.find('.btn-analyse-margins-awaiting').off('click').on('click', () => {
			const unassigned = this.get_filtered_orders().filter(o => !o.custom_truck_number);
			let selected_orders_data = unassigned.filter(o => this.selected_orders.has(o.name));
			const truck_input_val = this.container.find('.ta-bulk-truck-input').val().trim();
			const include_current = this.container.find('.ta-include-current-chk').is(':checked');
			if (include_current && truck_input_val) {
				const current_truck_orders = this.orders.filter(o => o.custom_truck_number === truck_input_val);
				const selectedNames = new Set(selected_orders_data.map(o => o.name));
				selected_orders_data = [...selected_orders_data, ...current_truck_orders.filter(o => !selectedNames.has(o.name))];
			}
			const truck_info = this.available_trucks.find(t => t.truck_number === truck_input_val);
			this.open_margin_analyzer('Margin Analysis: Awaiting Orders', selected_orders_data,
				truck_info ? truck_info.capacity_kg : null, truck_input_val || null);
		});

		this.container.find('.btn-analyse-margins-truck').off('click').on('click', (e) => {
			const tn = $(e.currentTarget).data('truck');
			const truck_orders = this.orders.filter(o => o.custom_truck_number === tn);
			const truck_info = this.available_trucks.find(t => t.truck_number === tn);

			// Same merge as Optimize Route above — combines this truck's
			// currently-assigned orders with any awaiting orders checked in
			// the table, so the margin preview reflects both together.
			const unassigned = this.get_filtered_orders().filter(o => !o.custom_truck_number);
			const checked_unassigned = unassigned.filter(o => this.selected_orders.has(o.name));
			const truck_order_names = new Set(truck_orders.map(o => o.name));
			const combined_orders = [
				...truck_orders,
				...checked_unassigned.filter(o => !truck_order_names.has(o.name))
			];

			this.open_margin_analyzer(`Margin Analysis: ${tn}`, combined_orders, truck_info ? truck_info.capacity_kg : null, tn);
		});
	}

	// ── Bulk assignment ───────────────────────────────────────────────────────

	_bulk_assign(truck_number) {
		const unassigned = this.get_filtered_orders().filter(o => !o.custom_truck_number);
		const to_assign  = unassigned.filter(o => this.selected_orders.has(o.name));

		if (!to_assign.length) {
			frappe.msgprint(__('No selected orders to assign.'));
			return;
		}

		if (!this.available_trucks.find(t => t.truck_number === truck_number)) {
			const m = this.saved_meta[truck_number] || {};
			this.available_trucks.push({
				truck_number,
				driver_name: m.driver_name || '',
				capacity_kg: m.capacity_kg != null ? m.capacity_kg : 5000,
				trip_id:     m.trip_id     || this._gen_trip_id(),
			});
		}

		const over = this._check_capacity(truck_number, to_assign);
		if (over) {
			frappe.msgprint({
				title: __('Truck Over Capacity'),
				message: __(
					'Cannot assign {0} order(s) to truck <strong>{1}</strong>.<br>' +
					'Current load: <strong>{2} kg</strong><br>' +
					'These orders add: <strong>{3} kg</strong><br>' +
					'Total would be: <strong>{4} kg</strong> — exceeds capacity of <strong>{5} kg</strong>.',
					[to_assign.length, truck_number,
					 over.current.toFixed(0), over.adding.toFixed(0),
					 over.total.toFixed(0), over.capacity.toFixed(0)]
				),
				indicator: 'red',
			});
			return;
		}

		frappe.confirm(
			__('Assign {0} order(s) to truck {1}?', [to_assign.length, truck_number]),
			() => {
				this._set_truck_batch(to_assign, truck_number, () => {
					this.selected_orders.clear();
					frappe.show_alert({
						message: __('✓ {0} orders assigned to {1}', [to_assign.length, truck_number]),
						indicator: 'green',
					});
					this.load_data();
				});
			}
		);
	}

	// ── Backend calls ─────────────────────────────────────────────────────────

	_check_capacity(truck_number, orders_to_add) {
	const truck    = this.available_trucks.find(t => t.truck_number === truck_number);
	// ✅ Look up the actual number from the map
	const capacity = truck ? (this.vehicle_capacity_map[truck.capacity_kg] || 0) : 0;
		if (!capacity) return null; // no limit configured

		const names_to_add = new Set(orders_to_add.map(o => (typeof o === 'string' ? o : o.name)));
		const current_weight = this.orders
			.filter(o => o.custom_truck_number === truck_number && !names_to_add.has(o.name))
			.reduce((s, o) => s + (o.total_net_weight || 0), 0);
		const adding_weight = orders_to_add.reduce((s, o) => {
			if (typeof o === 'string') {
				const found = this.orders.find(x => x.name === o);
				return s + ((found && found.total_net_weight) || 0);
			}
			return s + (o.total_net_weight || 0);
		}, 0);
		const total = current_weight + adding_weight;
		if (total > capacity) {
			return { current: current_weight, adding: adding_weight, total, capacity };
		}
		return null;
	}

	_set_truck(order_name, truck_number) {
		if (truck_number) {
			const over = this._check_capacity(truck_number, [order_name]);
			if (over) {
				frappe.msgprint({
					title: __('Truck Over Capacity'),
					message: __(
						'Cannot assign order to truck <strong>{0}</strong>.<br>' +
						'Current load: <strong>{1} kg</strong><br>' +
						'This order adds: <strong>{2} kg</strong><br>' +
						'Total would be: <strong>{3} kg</strong> — exceeds capacity of <strong>{4} kg</strong>.',
						[truck_number,
						 over.current.toFixed(0), over.adding.toFixed(0),
						 over.total.toFixed(0), over.capacity.toFixed(0)]
					),
					indicator: 'red',
				});
				this.render_view(); // reset the input dropdown
				return;
			}
		}
		frappe.call({
			method: 'crystal_custom.crystal_customizations.page.sales_order_truck_as.sales_order_truck_as.set_truck_number',
			args: { order_name, truck_number },
			callback: () => {
				frappe.show_alert({
					message: truck_number ? __('Assigned to {0}', [truck_number]) : __('Truck unassigned'),
					indicator: truck_number ? 'green' : 'orange',
				});
				this.load_data();
			},
		});
	}

	_set_truck_batch(orders, truck_number, on_done) {
		let done = 0;
		const next = () => {
			if (done >= orders.length) {
				if (on_done) on_done();
				else {
					frappe.show_alert({ message: __('Done — {0} orders updated', [orders.length]), indicator: 'green' });
					this.load_data();
				}
				return;
			}
			frappe.call({
				method: 'crystal_custom.crystal_customizations.page.sales_order_truck_as.sales_order_truck_as.set_truck_number',
				args: { order_name: orders[done].name, truck_number },
				callback: () => { done++; next(); },
				error:    () => { done++; next(); },
			});
		};
		next();
	}

	// ── Actions ───────────────────────────────────────────────────────────────

	edit_truck_details(truck_number) {
		const truck = this.available_trucks.find(t => t.truck_number === truck_number);
		frappe.prompt([
			{ label: 'Truck Number', fieldname: 'truck_number', fieldtype: 'Data',  default: truck.truck_number, reqd: 1 },
			{ label: 'Driver Name',  fieldname: 'driver_name',  fieldtype: 'Data',  default: truck.driver_name },
			{ label: 'Vehicle Type', fieldname: 'capacity_kg', fieldtype: 'Link', options: 'Vehicle Type', default: truck.capacity_kg, reqd: 1 },
		], (vals) => {
			const old_num = truck.truck_number;
			truck.truck_number = vals.truck_number;
			truck.driver_name  = vals.driver_name;
			truck.capacity_kg  = vals.capacity_kg;
			this._save_truck_meta();

			// Keep Crystal Truck Plan in sync
			if (truck.plan_name) {
				frappe.call({
					method: 'crystal_custom.crystal_customizations.page.sales_order_truck_as.sales_order_truck_as.update_truck_plan_meta',
					args: {
						plan_name:    truck.plan_name,
						truck_number: vals.truck_number,
						driver_name:  vals.driver_name,
						capacity_kg:  vals.capacity_kg,
					},
				});
			}

			if (old_num !== vals.truck_number) {
				// Fetch ALL orders with the old truck number directly from DB — do not rely on
				// this.orders which may be incomplete due to active SP/region/date filters.
				frappe.call({
					method: 'frappe.client.get_list',
					args: {
						doctype: 'Sales Order',
						fields: ['name'],
						filters: [['Sales Order', 'custom_truck_number', '=', old_num]],
						limit_page_length: 0,
					},
					callback: (r) => {
						const all_orders = r.message || [];
						if (all_orders.length) {
							this._set_truck_batch(all_orders, vals.truck_number);
						} else {
							this.load_data();
						}
					},
					error: () => this.load_data(),
				});
			} else {
				this.render_view();
			}
			frappe.show_alert({ message: __('Truck updated'), indicator: 'green' });
		}, __('Edit Truck'), __('Update'));
	}

	reassign_truck_orders(truck_number) {
		// Only move orders that are not yet invoiced — completed/closed orders stay put
		const truck_orders  = this.orders.filter(o =>
			o.custom_truck_number === truck_number &&
			o.so_status !== 'Completed' && o.so_status !== 'Closed'
		);
		const other_trucks  = this.available_trucks.filter(t => t.truck_number !== truck_number);
		if (!other_trucks.length) {
			frappe.msgprint(__('No other trucks available. Add another truck first.'));
			return;
		}
		if (!truck_orders.length) {
			frappe.msgprint(__('All orders on this truck are already invoiced and cannot be moved.'));
			return;
		}
		frappe.prompt([{
			label: 'Move all orders to',
			fieldname: 'new_truck',
			fieldtype: 'Select',
			options: other_trucks.map(t => t.truck_number + (t.driver_name ? ' — ' + t.driver_name : '')).join('\n'),
			reqd: 1,
		}], (vals) => {
			const new_truck = vals.new_truck.split(' — ')[0];
			this._set_truck_batch(truck_orders, new_truck);
		}, __('Reassign from {0}', [truck_number]), __('Move'));
	}

	delete_truck(truck_number) {
		const truck_orders = this.orders.filter(o => o.custom_truck_number === truck_number);
		if (!truck_orders.length) {
			this.available_trucks = this.available_trucks.filter(t => t.truck_number !== truck_number);
			this._save_truck_meta();
			frappe.show_alert({ message: __('Truck removed'), indicator: 'green' });
			this.render_view();
		} else {
			frappe.confirm(
				__('Unassign {0} orders from {1}? They will return to the unassigned list.', [truck_orders.length, truck_number]),
				() => this._set_truck_batch(truck_orders, '')
			);
		}
	}

	close_truck(truck_number) {
		const truck_orders = this.orders.filter(o => o.custom_truck_number === truck_number);
		if (!truck_orders.length) { frappe.msgprint(__('Cannot dispatch an empty truck')); return; }

		const unsubmitted = truck_orders.filter(o => parseInt(o.docstatus) === 0);
		const msg = unsubmitted.length
			? __('Truck {0} has {1} unsubmitted order(s). Dispatch anyway? Orders will be recorded and the truck stays available for the next load.', [truck_number, unsubmitted.length])
			: __('Dispatch truck {0}? {1} orders will be recorded in a Trip Plan and the truck stays available for the next load.', [truck_number, truck_orders.length]);

		frappe.confirm(msg, () => {
			this.download_manifest(truck_number);
			this._close_truck_batch(truck_number, truck_orders);
		});
	}

	_close_truck_batch(truck_number, truck_orders, on_done) {
		const truck_info  = this.available_trucks.find(t => t.truck_number === truck_number) || {};
		const new_trip_id = this._gen_trip_id();

		const closure = {
			trip_id:      truck_info.trip_id || '',
			truck_number,
			driver_name:  truck_info.driver_name || '',
			capacity_kg:  truck_info.capacity_kg || 0,
			closed_at:    frappe.datetime.now_datetime(),
			order_count:  truck_orders.length,
			total_weight: truck_orders.reduce((s, o) => s + (o.total_net_weight || 0), 0),
			total_value:  truck_orders.reduce((s, o) => s + (o.grand_total || 0), 0),
			orders: truck_orders.map(o => ({
				name:            o.name,
				customer_name:   o.customer_name || o.customer,
				delivery_region: o.custom_delivery_region || '',
			})),
		};

		const orders_meta = truck_orders.map(o => ({
			name:             o.name,
			customer_name:    o.customer_name || o.customer || '',
			delivery_region:  o.custom_delivery_region || '',
			grand_total:      o.grand_total || 0,
			total_net_weight: o.total_net_weight || 0,
		}));

		// Run both operations in parallel: mark orders closed on SOs + submit/restart CTP
		let orders_done = false, plan_done = false, new_plan_name = '';

		const finish = () => {
			if (!orders_done || !plan_done) return;

			// Give truck a fresh trip ID and plan for the next load
			const truck_idx = this.available_trucks.findIndex(t => t.truck_number === truck_number);
			if (truck_idx >= 0) {
				this.available_trucks[truck_idx].trip_id  = new_trip_id;
				this.available_trucks[truck_idx].plan_name = new_plan_name;
			}
			this._save_truck_meta();

			frappe.show_alert({ message: __('Trip dispatched for {0} — ready for next load', [truck_number]), indicator: 'green' });

			if (on_done) {
				// Caller manages the final reload (e.g., bulk dispatch chains multiple trucks)
				on_done();
			} else {
				// Single dispatch: refresh trip history then reload
				frappe.call({
					method: 'crystal_custom.crystal_customizations.page.sales_order_truck_as.sales_order_truck_as.get_truck_history',
					callback: (hr) => {
						this.closed_trucks = hr.message || [];
						this.load_data();
					},
					error: () => this.load_data(),
				});
			}
		};

		// 1. Batch-set custom_truck_closed=1 on all Sales Orders
		frappe.call({
			method: 'crystal_custom.crystal_customizations.page.sales_order_truck_as.sales_order_truck_as.close_truck_orders',
			args:   { order_names_json: JSON.stringify(truck_orders.map(o => o.name)) },
			callback: () => { orders_done = true; finish(); },
			error:    () => { orders_done = true; finish(); },
		});

		// 2. Submit the active Crystal Truck Plan + create a new Draft for the next trip
		frappe.call({
			method: 'crystal_custom.crystal_customizations.page.sales_order_truck_as.sales_order_truck_as.dispatch_and_restart_truck',
			args: {
				plan_name:    truck_info.plan_name || '',
				truck_number: truck_number,
				driver_name:  truck_info.driver_name || '',
				capacity_kg:  truck_info.capacity_kg || 0,
				orders_json:  JSON.stringify(orders_meta),
				new_trip_id:  new_trip_id,
			},
			callback: (r) => { new_plan_name = (r.message || {}).new_plan || ''; plan_done = true; finish(); },
			error:    () => { plan_done = true; finish(); },
		});
	}


	reopen_truck(idx) {
		const ct = this.closed_trucks[idx];
		if (!ct) return;

		frappe.confirm(
			__('Reopen truck {0}? Orders will be restored to active.', [ct.truck_number]),
			() => {
				// Always look up by truck number in the DB — works even for trucks
				// closed before the orders array was stored in the closure record.
				frappe.call({
					method: 'frappe.client.get_list',
					args: {
						doctype: 'Sales Order',
						fields: ['name'],
						filters: [
							['Sales Order', 'custom_truck_number', '=', ct.truck_number],
							['Sales Order', 'custom_truck_closed', '=', 1],
						],
						limit_page_length: 500,
					},
					callback: (r) => {
						const orders = r.message || [];
						let done = 0;
						const finish = () => {
							// Remove from closed history and persist
							this.closed_trucks.splice(idx, 1);
							frappe.call({
								method: 'crystal_custom.crystal_customizations.page.sales_order_truck_as.sales_order_truck_as.save_closed_trucks',
								args: { closed_trucks_json: JSON.stringify(this.closed_trucks) },
							});

							// Restore to active truck list and persist meta
							if (!this.available_trucks.find(t => t.truck_number === ct.truck_number)) {
								this.available_trucks.push({
									truck_number: ct.truck_number,
									driver_name:  ct.driver_name  || '',
									capacity_kg:  ct.capacity_kg  || 5000,
									trip_id:      this._gen_trip_id(),
								});
								this._save_truck_meta();
							}

							frappe.show_alert({
								message: __('Truck {0} reopened — {1} order(s) restored', [ct.truck_number, orders.length]),
								indicator: 'green',
							});
							this.load_data();
						};

						if (!orders.length) { finish(); return; }

						const next = () => {
							if (done >= orders.length) { finish(); return; }
							frappe.call({
								method: 'crystal_custom.crystal_customizations.page.sales_order_truck_as.sales_order_truck_as.set_truck_closed',
								args: { order_name: orders[done].name, value: 0 },
								callback: () => { done++; next(); },
								error:    () => { done++; next(); },
							});
						};
						next();
					},
					error: () => frappe.msgprint(__('Could not load orders for truck {0}', [ct.truck_number])),
				});
			}
		);
	}

	edit_closed_truck(idx) {
		const ct = this.closed_trucks[idx];
		if (!ct) return;

		frappe.prompt([
			{ label: 'Driver Name',   fieldname: 'driver_name', fieldtype: 'Data',  default: ct.driver_name || '' },
			{ label: 'Capacity (kg)', fieldname: 'capacity_kg', fieldtype: 'Float', default: ct.capacity_kg  || 5000 },
		], (vals) => {
			ct.driver_name = vals.driver_name;
			ct.capacity_kg = vals.capacity_kg;
			frappe.call({
				method: 'crystal_custom.crystal_customizations.page.sales_order_truck_as.sales_order_truck_as.save_closed_trucks',
				args: { closed_trucks_json: JSON.stringify(this.closed_trucks) },
				callback: () => {
					frappe.show_alert({ message: __('Truck {0} updated', [ct.truck_number]), indicator: 'green' });
					this.render_view();
				},
			});
		}, __('Edit Truck {0}', [ct.truck_number]), __('Save'));
	}

	download_manifest(truck_number) {
		const truck_orders = this.orders.filter(o => o.custom_truck_number === truck_number);
		const truck_info   = this.available_trucks.find(t => t.truck_number === truck_number);
		if (!truck_orders.length) { frappe.msgprint(__('No orders in this truck')); return; }

		const total_weight = truck_orders.reduce((s, o) => s + (o.total_net_weight || 0), 0);
		const total_value  = truck_orders.reduce((s, o) => s + (o.grand_total || 0), 0);
		// Sort by region for manifest readability
		const sorted = [...truck_orders].sort((a, b) =>
			(a.custom_delivery_region || '').localeCompare(b.custom_delivery_region || '')
		);

		const driver_cols = truck_info && truck_info.driver_name
			? `<td style="border:none;font-weight:bold;padding-left:20px">Driver:</td><td style="border:none">${truck_info.driver_name}</td>`
			: '';

		const rows = sorted.map(o => {
			const status = o.docstatus === 1 ? 'Submitted'
				: o.workflow_state === 'Order Confirmed' ? 'Confirmed'
				: o.workflow_state === 'Pending Customer Order Reconfirmation' ? 'Pending Confirm'
				: 'Draft';
			return `<tr>
				<td>${o.name}</td>
				<td>${o.customer_name || o.customer}</td>
				<td>${o.custom_delivery_region || ''}</td>
				<td style="text-align:right">${(o.total_net_weight || 0).toFixed(2)}</td>
				<td style="text-align:right">${o.grand_total.toFixed(2)}</td>
				<td>${status}</td>
				<td style="text-align:center">${o.custom_call_not_picked ? 'YES' : 'NO'}</td>
				<td>${o.custom_call_notes || ''}</td>
			</tr>`;
		}).join('');

		const html = `<html xmlns:o="urn:schemas-microsoft-com:office:office"
			xmlns:x="urn:schemas-microsoft-com:office:excel"
			xmlns="http://www.w3.org/TR/REC-html40">
<head><meta charset="utf-8">
<style>table{border-collapse:collapse}th,td{border:1px solid #ddd;padding:8px;text-align:left}th{background:#1e293b;color:#fff;font-weight:bold}</style>
</head><body>
<h2 style="font-family:sans-serif">TRUCK DELIVERY MANIFEST</h2>
<table style="margin-bottom:16px;border:none;font-family:sans-serif"><tr style="border:none">
<td style="border:none;font-weight:bold">Truck:</td><td style="border:none">${truck_number}</td>
${driver_cols}
<td style="border:none;font-weight:bold;padding-left:20px">Date:</td><td style="border:none">${frappe.datetime.now_date()}</td>
<td style="border:none;font-weight:bold;padding-left:20px">Orders:</td><td style="border:none">${truck_orders.length}</td>
<td style="border:none;font-weight:bold;padding-left:20px">Weight:</td><td style="border:none">${total_weight.toFixed(2)} kg</td>
<td style="border:none;font-weight:bold;padding-left:20px">Value:</td><td style="border:none">${total_value.toFixed(2)}</td>
</tr></table>
<table><thead><tr>
<th>Order</th><th>Customer</th><th>Region</th><th>Weight (kg)</th><th>Value</th><th>Status</th><th>Call Issue</th><th>Notes</th>
</tr></thead><tbody>${rows}</tbody></table>
</body></html>`;

		const blob = new Blob([html], { type: 'application/vnd.ms-excel;charset=utf-8;' });
		const a = document.createElement('a');
		a.href = URL.createObjectURL(blob);
		a.download = `Truck_${truck_number}_${frappe.datetime.now_date()}.xls`;
		a.style.display = 'none';
		document.body.appendChild(a);
		a.click();
		document.body.removeChild(a);

		frappe.show_alert({ message: __('Manifest downloaded for {0}', [truck_number]), indicator: 'green' });
	}

// ── Spatial / Routing Logic (Leaflet + Nexus Backend) ─────────────────────

	open_route_optimizer(title, orders, vehicle_type, truck_number = null) {
		this.page.wrapper.find('.nexus-route-panel').addClass('active');
		this.page.wrapper.find('.nexus-panel-backdrop').addClass('active');
		this.page.wrapper.find('.nexus-panel-title').text(title);

		$('#nx-dist').html('<i class="fa fa-spinner fa-spin"></i>');
		$('#nx-dur').html('<i class="fa fa-spinner fa-spin"></i>');
		$('#nx-fuel-cost').html('<i class="fa fa-spinner fa-spin"></i>');
		$('.nexus-fuel-banner').show();

		frappe.require([
			"/assets/nexus_supply_chain/leaflet/leaflet.css",
			"/assets/nexus_supply_chain/leaflet/leaflet.js"
		], () => {
			this._execute_route_mapping(orders, vehicle_type, 'nexus-leaflet-map', truck_number);
		});
	}

	_execute_route_mapping(orders, vehicle_type, container_id, truck_number = null) {
		frappe.call({
			method: 'crystal_custom.crystal_customizations.page.sales_order_truck_as.sales_order_truck_as.get_company_coordinates',
			callback: (r) => {
				if (!r.message || r.message.status === 'error') {
					frappe.msgprint("Factory coordinates not set in Global Defaults. Cannot map route.");
					return;
				}
				const factory_lat = parseFloat(r.message.lat);
				const factory_lng = parseFloat(r.message.lng);

				const valid_stops = orders.filter(o =>
					o.custom_latitude && o.custom_longitude &&
					parseFloat(o.custom_latitude) !== 0 && parseFloat(o.custom_longitude) !== 0
				);
				const unmapped_stops = orders.filter(o =>
					!o.custom_latitude || !o.custom_longitude ||
					parseFloat(o.custom_latitude) === 0 || parseFloat(o.custom_longitude) === 0
				);

				if (unmapped_stops.length > 0) {
					const unmapped_html = unmapped_stops.map(o => `<b>${o.name}</b> (${frappe.utils.escape_html(o.customer_name)})`).join(', ');
					$('#nexus-unmapped-list').html(unmapped_html);
					$('#nexus-unmapped-banner').slideDown(200);
				} else {
					$('#nexus-unmapped-banner').hide();
				}

				if (valid_stops.length === 0) {
					frappe.msgprint("None of the mapped orders have valid GPS coordinates. Showing unmapped load.");
					$('#nx-dist').text('0 km'); $('#nx-dur').text('0 hrs'); $('#nx-fuel-cost').text('N/A');
					this._render_leaflet_map({ features: [] }, factory_lat, factory_lng, [], container_id);
					return;
				}

				let coordinates = [[factory_lng, factory_lat]];
				valid_stops.forEach(o => coordinates.push([parseFloat(o.custom_longitude), parseFloat(o.custom_latitude)]));
				coordinates.push([factory_lng, factory_lat]);

				frappe.call({
					method: 'crystal_custom.crystal_customizations.page.sales_order_truck_as.sales_order_truck_as.calculate_route_proxy',
					args: { coordinates_json: JSON.stringify(coordinates) },
					callback: (route_r) => {
						const data = route_r.message;
						if (!data || data.error) {
							frappe.msgprint("Map Engine Error: " + (data ? data.error : "Unknown error"));
							return;
						}

						let ordered_stops = valid_stops;
						if (Array.isArray(data.waypoint_order) && data.waypoint_order.length === valid_stops.length) {
							ordered_stops = data.waypoint_order.map(idx => valid_stops[idx]).filter(Boolean);
						}

						this._render_leaflet_map(data, factory_lat, factory_lng, ordered_stops, container_id);

						const distance_km  = data.features[0].properties.summary.distance / 1000;
						const duration_hrs = data.features[0].properties.summary.duration / 3600;
						$('#nx-dist').text(distance_km.toFixed(1) + ' km');
						$('#nx-dur').text(duration_hrs.toFixed(1) + ' hrs');

						if (truck_number) {
							const sequence = ordered_stops.map(o => o.name);
							frappe.call({
								method: 'crystal_custom.crystal_customizations.page.sales_order_truck_as.sales_order_truck_as.reorder_truck_plan_orders',
								args: { truck_number: truck_number, sales_order_sequence_json: JSON.stringify(sequence) }
							});
						}

						if (vehicle_type || truck_number) {
							frappe.call({
								method: 'crystal_custom.crystal_customizations.page.sales_order_truck_as.sales_order_truck_as.get_vehicle_routing_economics',
								args: { distance_km: distance_km, vehicle_type: vehicle_type, truck_number: truck_number },
								callback: (cost_r) => {
									if (cost_r.message && cost_r.message.status === 'success') {
										const estCost = parseFloat(cost_r.message.estimated_fuel_cost) || 0.0;
										$('#nx-fuel-cost').text(`${cost_r.message.currency} ${estCost.toLocaleString(undefined, { minimumFractionDigits: 2 })}`);
									} else {
										const errMsg = cost_r.message && cost_r.message.message ? cost_r.message.message : 'Unknown Backend Error';
										console.warn("Vehicle Routing Economics:", errMsg);
										$('#nx-fuel-cost').text('Math Err');
									}
								}
							});
						} else {
							$('#nx-fuel-cost').text('Select Truck to Estimate');
						}
					},
					error: () => frappe.msgprint("Failed to communicate with the routing engine orchestrator.")
				});
			}
		});
	}

	_render_leaflet_map(geojson_data, factory_lat, factory_lng, valid_stops, container_id) {
		if (!this.route_map) {
			this.route_map = L.map(container_id, { zoomControl: false }).setView([factory_lat, factory_lng], 12);
			L.control.zoom({ position: 'topright' }).addTo(this.route_map);
			L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { attribution: 'Nexus Spatial Engine' }).addTo(this.route_map);
			this.map_layers = [];
		}

		this.map_layers.forEach(layer => this.route_map.removeLayer(layer));
		this.map_layers = [];

		const routeLayer = L.geoJSON(geojson_data, {
			style: { color: '#3b82f6', weight: 6, opacity: 0.85, dashArray: '10, 6' }
		}).addTo(this.route_map);
		this.map_layers.push(routeLayer);

		const factoryIcon = L.divIcon({
			className: '', html: `<div class="nexus-factory-marker"><i class="fa fa-industry" style="color:white;"></i></div>`, iconSize: [36, 36], iconAnchor: [18, 18]
		});
		const f_marker = L.marker([factory_lat, factory_lng], { icon: factoryIcon, zIndexOffset: 1000 })
			.addTo(this.route_map).bindPopup("Factory Dispatch");
		this.map_layers.push(f_marker);

		valid_stops.forEach((so, i) => {
			const icon = L.divIcon({
				className: '', html: `<div class="nexus-map-marker">${i + 1}</div>`, iconSize: [28, 28], iconAnchor: [14, 14]
			});
			const m = L.marker([so.custom_latitude, so.custom_longitude], { icon: icon }).addTo(this.route_map)
				.bindPopup(`<b>Stop ${i + 1}: ${so.customer_name}</b><br>Order Value: ${format_currency(so.grand_total)}<br>Tonnage: ${(so.total_net_weight || 0).toFixed(1)} kg`);
			this.map_layers.push(m);
		});

		if (valid_stops.length > 0) {
			this.route_map.fitBounds(routeLayer.getBounds(), { padding: [60, 60] });
		} else {
			this.route_map.setView([factory_lat, factory_lng], 12);
		}

		setTimeout(() => { this.route_map.invalidateSize(); }, 350);
	}

	// ── Margin Analysis Logic (mirrors the routing logic above, opposite panel) ─

	open_margin_analyzer(title, orders, vehicle_type, truck_number = null) {
		this.page.wrapper.find('.nexus-margin-panel-title').text(title);
		this.open_margin_panel();
		$('#nexus-margin-content').html(`
			<div class="text-center py-5">
				<i class="fa fa-spinner fa-spin fa-2x text-primary"></i>
				<p class="text-muted mt-3">Computing margin analysis...</p>
			</div>
		`);
		this._execute_margin_analysis(orders, vehicle_type, truck_number);
	}

	_execute_margin_analysis(orders, vehicle_type, truck_number) {
		if (!orders.length) {
			$('#nexus-margin-content').html(`<div class="alert alert-warning mt-2">No orders selected for margin analysis.</div>`);
			return;
		}

		const valid_stops = orders.filter(o =>
			o.custom_latitude && o.custom_longitude &&
			parseFloat(o.custom_latitude) !== 0 && parseFloat(o.custom_longitude) !== 0
		);
		const unmapped_stops = orders.filter(o =>
			!o.custom_latitude || !o.custom_longitude ||
			parseFloat(o.custom_latitude) === 0 || parseFloat(o.custom_longitude) === 0
		);

		const sales_order_names = orders.map(o => o.name);

		const run_analysis = (distance_km) => {
			frappe.call({
				method: 'nexus_supply_chain.routing.margin_analysis.get_margin_analysis',
				args: {
					sales_orders: JSON.stringify(sales_order_names),
					distance_km: distance_km,
					vehicle_type: vehicle_type,
					truck_number: truck_number
				},
				callback: (r) => {
					this.render_margin_panel(orders.length, r.message, unmapped_stops.length);
				},
				error: () => {
					$('#nexus-margin-content').html(`<div class="alert alert-danger mt-2">Server error computing margin analysis.</div>`);
				}
			});
		};

		if (valid_stops.length === 0) {
			run_analysis(null);
			return;
		}

		frappe.call({
			method: 'crystal_custom.crystal_customizations.page.sales_order_truck_as.sales_order_truck_as.get_company_coordinates',
			callback: (r) => {
				if (!r.message || r.message.status === 'error') { run_analysis(null); return; }

				const factory_lat = parseFloat(r.message.lat);
				const factory_lng = parseFloat(r.message.lng);

				let coordinates = [[factory_lng, factory_lat]];
				valid_stops.forEach(o => coordinates.push([parseFloat(o.custom_longitude), parseFloat(o.custom_latitude)]));
				coordinates.push([factory_lng, factory_lat]);

				frappe.call({
					method: 'crystal_custom.crystal_customizations.page.sales_order_truck_as.sales_order_truck_as.calculate_route_proxy',
					args: { coordinates_json: JSON.stringify(coordinates) },
					callback: (route_r) => {
						const data = route_r.message;
						if (!data || data.error) { run_analysis(null); return; }
						const distance_km = data.features[0].properties.summary.distance / 1000;
						run_analysis(distance_km);
					},
					error: () => run_analysis(null)
				});
			}
		});
	}

	render_margin_panel(order_count, data, unmapped_count) {
		if (!data || data.status !== 'success') {
			$('#nexus-margin-content').html(`
				<div class="alert alert-danger mt-2">
					<i class="fa fa-exclamation-triangle me-2"></i>
					Failed to compute margin analysis.
				</div>
			`);
			return;
		}

		const currency = data.currency || 'KES';
		const fmt = (val) => `${currency} ${parseFloat(val || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

		const is_profitable = data.narrowed_gross_margin_percentage >= this.profitability_threshold;
		const headline_class = is_profitable ? 'profitable' : 'loss';
		const headline_color = is_profitable ? '#166534' : '#991b1b';

		let fuel_html = '';
		if (data.distance_available && data.fuel_available) {
			fuel_html = `
				<div class="margin-stat-row">
					<span class="margin-stat-label">Route Distance (Roundtrip)</span>
					<span class="margin-stat-value">${data.distance_km.toFixed(1)} km</span>
				</div>
				<div class="margin-stat-row">
					<span class="margin-stat-label">Estimated Fuel Cost</span>
					<span class="margin-stat-value" style="color:#ef4444;">${fmt(data.approximate_fuel_cost)}</span>
				</div>
			`;
		} else if (data.distance_available && !data.fuel_available) {
			fuel_html = `<div class="alert alert-warning mt-2" style="font-size:12px;">Fuel estimate unavailable — assign a Vehicle Type to this truck to estimate fuel cost.</div>`;
		} else {
			fuel_html = `<div class="alert alert-secondary mt-2" style="font-size:12px;">Distance unavailable — no GPS data on any selected order.</div>`;
		}

		let unmapped_html = '';
		if (unmapped_count > 0) {
			unmapped_html = `
				<div class="alert alert-warning mt-2" style="font-size:12px;">
					<i class="fa fa-exclamation-triangle me-1"></i>
					${unmapped_count} order(s) excluded from the distance/fuel estimate — no GPS coordinates.
				</div>
			`;
		}

		let zero_cost_html = '';
		if (data.zero_cost_items && data.zero_cost_items.length > 0) {
			zero_cost_html = `
				<div class="margin-zero-cost-warning">
					<b><i class="fa fa-exclamation-triangle me-1"></i> Margin Accuracy Warning</b><br>
					The following item(s) have no Default BOM — their cost was treated as 0, which inflates the margin above:
					<div class="mt-1"><b>${data.zero_cost_items.join(', ')}</b></div>
				</div>
			`;
		}

		const html = `
			<div class="mb-3 text-muted" style="font-size:12px;">${order_count} order(s) analysed</div>

			<div class="margin-stat-row">
				<span class="margin-stat-label">Total Order Value (Incl. VAT)</span>
				<span class="margin-stat-value">${fmt(data.total_order_value)}</span>
			</div>
			<div class="margin-stat-row">
				<span class="margin-stat-label">VAT (${data.vat_rate_percentage.toFixed(0)}%)</span>
				<span class="margin-stat-value text-muted">- ${fmt(data.vat_amount)}</span>
			</div>
			<div class="margin-stat-row">
				<span class="margin-stat-label">Revenue (Excl. VAT)</span>
				<span class="margin-stat-value">${fmt(data.revenue_excl_vat)}</span>
			</div>
			<div class="margin-stat-row">
				<span class="margin-stat-label">Total Theoretical Cost (COGS)</span>
				<span class="margin-stat-value text-muted">- ${fmt(data.total_theoretical_cost)}</span>
			</div>
			<div class="margin-stat-row">
				<span class="margin-stat-label">Gross Profit</span>
				<span class="margin-stat-value">${fmt(data.gross_profit)}</span>
			</div>
			<div class="margin-stat-row" style="border-bottom:none;">
				<span class="margin-stat-label">Gross Margin %</span>
				<span class="margin-stat-value">${data.gross_margin_percentage.toFixed(2)}%</span>
			</div>

			${fuel_html}
			${unmapped_html}

			<div class="margin-headline ${headline_class}">
				<div class="margin-stat-label" style="color:${headline_color};">Narrowed Gross Margin</div>
				<div class="margin-headline-value" style="color:${headline_color};">${fmt(data.narrowed_gross_profit)}</div>
				<div class="margin-headline-pct" style="color:${headline_color};">${data.narrowed_gross_margin_percentage.toFixed(2)}% — ${is_profitable ? 'Profitable' : 'Loss'}</div>
			</div>

			${zero_cost_html}
		`;

		$('#nexus-margin-content').html(html);
	}

	// ── SP Pills ──────────────────────────────────────────────────────────────

	_render_sp_pills() {
		if (!this._sp_pills_wrap) return;
		if (!this._sps.size) { this._sp_pills_wrap.empty(); return; }
		const self = this;
		const html = Array.from(this._sps).map(sp =>
			`<span class="sp-pill">${frappe.utils.escape_html(sp)}<span class="sp-rm" data-sp="${frappe.utils.escape_html(sp)}">&times;</span></span>`
		).join('');
		this._sp_pills_wrap.html(`<style>.sp-pills-wrap{padding:4px 8px 2px;display:flex;flex-wrap:wrap;gap:4px;min-height:4px;}.sp-pill{background:#dbeafe;color:#1d4ed8;border-radius:12px;padding:2px 8px;font-size:11px;display:inline-flex;align-items:center;gap:3px;}.sp-rm{cursor:pointer;font-size:13px;line-height:1;margin-left:2px;color:#2563eb;font-weight:bold;}</style>${html}`);
		this._sp_pills_wrap.find('.sp-rm').on('click', function () {
			self._sps.delete($(this).data('sp'));
			self._render_sp_pills();
			self.load_data();
		});
	}

	_render_region_pills() {
		if (!this._region_pills_wrap) return;
		if (!this._regions.size) { this._region_pills_wrap.empty(); return; }
		const self = this;
		const html = Array.from(this._regions).map(r =>
			`<span class="rg-pill">${frappe.utils.escape_html(r)}<span class="rg-rm" data-rg="${frappe.utils.escape_html(r)}">&times;</span></span>`
		).join('');
		this._region_pills_wrap.html(`<style>.region-pills-wrap{padding:4px 8px 2px;display:flex;flex-wrap:wrap;gap:4px;min-height:4px;}.rg-pill{background:#dcfce7;color:#166534;border:1px solid #86efac;border-radius:12px;padding:2px 8px;font-size:11px;display:inline-flex;align-items:center;gap:3px;}.rg-rm{cursor:pointer;font-size:13px;line-height:1;margin-left:2px;color:#16a34a;font-weight:bold;}</style>${html}`);
		this._region_pills_wrap.find('.rg-rm').on('click', function () {
			self._regions.delete($(this).data('rg'));
			self._render_region_pills();
			 self.render_view();
		});
	}

	// ── Styles ────────────────────────────────────────────────────────────────

	_styles() {
		return `<style>
		.ta-container { margin-top: 16px; }

		/* Search bar */
		.ta-search-row {
			display: flex;
			align-items: center;
			gap: 12px;
			margin-bottom: 16px;
		}
		.ta-search-input {
			max-width: 340px;
			height: 34px;
			font-size: 13px;
			border-radius: 6px;
		}
		.ta-search-count {
			font-size: 12px;
			color: #6b7280;
			white-space: nowrap;
		}

		/* KPI row */
		.ta-kpi-row {
			display: grid;
			grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
			gap: 16px;
			margin-bottom: 24px;
		}
		.ta-kpi {
			background: #fff;
			border-radius: 8px;
			padding: 16px 20px;
			box-shadow: 0 1px 6px rgba(0,0,0,.07);
		}
		.ta-kpi-label { font-size: 12px; color: #6b7280; font-weight: 600; text-transform: uppercase; letter-spacing: .5px; }
		.ta-kpi-value { font-size: 22px; font-weight: 700; margin-top: 6px; }

		/* Sections */
		.ta-section {
			background: #fff;
			border-radius: 8px;
			padding: 16px;
			box-shadow: 0 1px 6px rgba(0,0,0,.07);
			margin-bottom: 24px;
		}
		.ta-section-header {
			font-size: 14px;
			font-weight: 700;
			color: #1e293b;
			margin-bottom: 16px;
			padding-bottom: 8px;
			border-bottom: 2px solid #f1f5f9;
			display: flex;
			align-items: center;
			gap: 8px;
		}
		.ta-count-badge {
			background: #667eea;
			color: #fff;
			border-radius: 12px;
			padding: 1px 9px;
			font-size: 12px;
			font-weight: 600;
		}

		/* Active / Dispatched sub-tabs */
		.ta-subtabs {
			display: flex;
			gap: 4px;
			border-bottom: 2px solid #e2e8f0;
			margin-bottom: 20px;
		}
		.ta-subtab-btn {
			background: none;
			border: none;
			border-bottom: 3px solid transparent;
			margin-bottom: -2px;
			padding: 8px 18px;
			font-weight: 600;
			font-size: 13px;
			color: #6b7280;
			cursor: pointer;
			display: flex;
			align-items: center;
			gap: 6px;
			outline: none;
			transition: color .2s;
		}
		.ta-subtab-btn:hover { color: #667eea; }
		.ta-subtab-btn.active { color: #667eea; border-bottom-color: #667eea; }
		.ta-subtab-badge {
			background: #667eea;
			color: #fff;
			border-radius: 10px;
			padding: 1px 7px;
			font-size: 11px;
			font-weight: 700;
		}

		/* Bulk assignment bar */
		.ta-bulk-bar {
			display: flex;
			align-items: center;
			gap: 10px;
			padding: 10px 14px;
			background: #f8fafc;
			border: 1px solid #e2e8f0;
			border-radius: 6px;
			margin-bottom: 10px;
			flex-wrap: wrap;
		}
		.ta-bulk-select-label {
			display: flex;
			align-items: center;
			gap: 6px;
			font-weight: 600;
			font-size: 13px;
			color: #374151;
			cursor: pointer;
			margin: 0;
			white-space: nowrap;
		}
		.ta-bulk-select-label input { width:15px; height:15px; accent-color:#667eea; cursor:pointer; }
		.ta-bulk-sep { flex: 1; }
		.ta-bulk-count { font-size: 13px; color: #6b7280; white-space: nowrap; }
		.ta-bulk-sel-stats { display:inline-flex; gap:8px; margin-left:8px; }
		.ta-bulk-sel-stat { font-size:12px; font-weight:600; color:#1e293b; background:#e0f2fe; border-radius:4px; padding:2px 8px; white-space:nowrap; }
		.ta-bulk-actions { display: flex; align-items: center; gap: 6px; }
		.ta-bulk-truck-input { width: 160px !important; height: 30px !important; font-size: 12px !important; }
		.ta-td-chk { width: 36px; text-align: center; }
		.ta-row-selected td { background: #eff6ff !important; }

		/* Truck multi-select */
		.ta-truck-bulk-bar {
			display: flex;
			align-items: center;
			justify-content: space-between;
			background: #1e293b;
			color: #fff;
			border-radius: 8px;
			padding: 10px 16px;
			margin-bottom: 12px;
			gap: 12px;
		}
		.ta-truck-bulk-info { font-size: 13px; }
		.ta-truck-chk-wrap { display:flex; align-items:center; cursor:pointer; flex-shrink:0; }
		.ta-truck-chk-wrap input { width:14px; height:14px; accent-color:#667eea; cursor:pointer; }
		.ta-truck-selected { border-color: #667eea !important; box-shadow: 0 0 0 2px rgba(102,126,234,.25); }

		/* Awaiting table */
		.ta-table-wrap { overflow-x: auto; }
		.ta-table thead th {
			background: #1e293b;
			color: #fff;
			font-size: 11px;
			font-weight: 600;
			text-transform: uppercase;
			letter-spacing: .4px;
			padding: 10px 10px !important;
			border: none !important;
			white-space: nowrap;
		}
		.ta-table .ta-group-row td {
			background: #f8fafc;
			font-size: 12px;
			padding: 6px 10px !important;
			color: #475569;
			border-top: 2px solid #e2e8f0 !important;
		}
		.ta-group-meta { margin-left: 10px; color: #94a3b8; font-weight: normal; }
		.ta-row td { padding: 10px !important; vertical-align: middle !important; font-size: 13px; }
		.ta-row:hover { background: #f8fafc !important; }
		.ta-row-pf td { background: #f0fdfa !important; }
		.ta-row-pf:hover td { background: #ccfbf1 !important; }
		.ta-amt { text-align: right; font-family: monospace; }
		.ta-warn-badge {
			display: inline-block;
			background: #f59e0b;
			color: #fff;
			border-radius: 3px;
			padding: 0 5px;
			font-size: 11px;
			font-weight: 700;
			margin-left: 4px;
			vertical-align: middle;
		}
		.ta-overdue-badge {
			display: inline-block;
			background: #ef4444;
			color: #fff;
			border-radius: 3px;
			padding: 0 5px;
			font-size: 11px;
			font-weight: 700;
			margin-left: 4px;
			vertical-align: middle;
		}
		.ta-submitted-badge {
			display: inline-block;
			background: #7c3aed;
			color: #fff;
			border-radius: 3px;
			padding: 0 5px;
			font-size: 11px;
			font-weight: 700;
			margin-left: 4px;
			vertical-align: middle;
		}
		.ta-orphan-badge {
			display: inline-block;
			background: #d97706;
			color: #fff;
			border-radius: 3px;
			padding: 0 5px;
			font-size: 11px;
			font-weight: 700;
			margin-left: 4px;
			vertical-align: middle;
		}
		.ta-note { color: #92400e; font-style: italic; }
		.ta-state-badge {
			display: inline-block;
			padding: 2px 8px;
			border-radius: 4px;
			font-size: 11px;
			font-weight: 600;
			color: #fff;
		}
		.ta-truck-input { font-size: 12px; height: 28px; padding: 2px 8px; }
		.ta-empty { color: #6b7280; font-style: italic; padding: 20px; text-align: center; }

		/* Truck cards - 3 COLUMNS */
		.ta-trucks-grid {
			display: grid;
			grid-template-columns: repeat(3, minmax(0, 1fr));
			gap: 16px;
		}
		@media (max-width: 1200px) {
			.ta-trucks-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
		}
		@media (max-width: 768px) {
			.ta-trucks-grid { grid-template-columns: minmax(0, 1fr); }
		}
		.ta-truck-card {
			border: 1px solid #e2e8f0;
			border-radius: 8px;
			background: #fff;
			display: flex;
			flex-direction: column;
			overflow: hidden;
		}
		.ta-truck-card.ta-truck-empty {
			border: 2px dashed #cbd5e1;
		}
		.ta-card-header {
			padding: 14px;
			background: #f8fafc;
			border-bottom: 2px solid #e2e8f0;
		}
		.ta-card-orders-section {
			padding: 14px;
			flex-grow: 1;
			background: #ffffff;
		}
		.ta-orders-header {
			font-size: 11px;
			font-weight: 700;
			color: #64748b;
			text-transform: uppercase;
			letter-spacing: 0.5px;
			margin-bottom: 10px;
			padding-bottom: 6px;
			border-bottom: 1px solid #f1f5f9;
		}
		.ta-truck-head {
			display: flex;
			justify-content: space-between;
			align-items: flex-start;
			margin-bottom: 2px;
			gap: 8px;
		}
		.ta-truck-chk-wrap {
			flex-shrink: 0;
			padding-top: 2px;
		}
		.ta-truck-title-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; flex: 1; min-width: 0; }
		.ta-truck-num { font-size: 15px; font-weight: 700; color: #1e293b; }
		.ta-status-badge {
			font-size: 10px;
			font-weight: 700;
			text-transform: uppercase;
			letter-spacing: 0.4px;
			padding: 2px 9px;
			border-radius: 12px;
			color: #fff;
		}
		.ta-status-badge.pending { background: #f59e0b; }
		.ta-status-badge.loaded  { background: #10b981; }
		.ta-trip-id { font-size: 11px; color: #94a3b8; margin-bottom: 8px; }
		.ta-truck-btns { display: flex; gap: 4px; flex-shrink: 0; }
		.ta-truck-driver {
			font-size: 12px;
			color: #475569;
			margin-bottom: 10px;
			font-weight: 500;
			display: flex;
			align-items: center;
			gap: 5px;
		}
		.ta-truck-btns-container {
			display: flex;
			flex-direction: column;
			gap: 8px;
			margin-top: 12px;
			padding-top: 12px;
			border-top: 1px solid #e2e8f0;
		}
		.ta-truck-actions-primary { display: flex; align-items: center; gap: 10px; width: 100%; }
		.ta-analyse-margins-link {
			font-size: 13px;
			font-weight: 600;
			color: #1e293b;
			cursor: pointer;
			white-space: nowrap;
			flex-shrink: 0;
		}
		.ta-analyse-margins-link:hover { color: #667eea; }
		.ta-truck-actions-primary .btn {
			flex: 1;
			display: inline-flex;
			align-items: center;
			justify-content: center;
			gap: 4px;
			white-space: nowrap;
		}
		.ta-truck-actions-icons {
			display: flex;
			gap: 6px;
			margin-top: 8px;
		}
		.ta-truck-warn {
			background: #fef3c7;
			border: 1px solid #f59e0b;
			border-radius: 4px;
			padding: 6px 10px;
			font-size: 11px;
			color: #92400e;
			margin-bottom: 8px;
		}
		.ta-truck-stats { display: flex; gap: 8px; margin-bottom: 8px; }
		.ta-truck-stat {
			flex: 1;
			background: #fff;
			border: 1px solid #e2e8f0;
			border-radius: 6px;
			padding: 8px 6px;
			text-align: center;
			font-size: 10px;
			color: #6b7280;
			text-transform: uppercase;
		}
		.ta-truck-stat span { display: block; font-size: 13px; font-weight: 700; color: #1e293b; margin-bottom: 2px; }
		.ta-cap-bar { background: #e2e8f0; border-radius: 4px; height: 6px; margin-bottom: 4px; overflow: hidden; }
		.ta-cap-fill { height: 100%; border-radius: 4px; }
		.ta-cap-label { font-size: 10px; color: #6b7280; margin-bottom: 8px; }
		.ta-truck-routes { display: flex; flex-wrap: wrap; gap: 4px; margin-bottom: 8px; }
		.ta-route-tag {
			display: inline-flex;
			align-items: center;
			gap: 4px;
			background: #fff;
			color: #475569;
			border: 1px solid #cbd5e1;
			border-radius: 16px;
			padding: 3px 10px;
			font-size: 11px;
			font-weight: 500;
		}
		.ta-truck-orders { max-height: 200px; overflow-y: auto; }
		.ta-truck-order {
			display: flex;
			justify-content: space-between;
			align-items: center;
			padding: 6px;
			margin-bottom: 4px;
			background: #f8fafc;
			border-radius: 4px;
			font-size: 12px;
		}
		.ta-order-link { font-weight: 600; color: #3b82f6; }
		.ta-order-cust { display: block; color: #6b7280; font-size: 11px; }
		.ta-order-loc  { display: block; color: #94a3b8; font-size: 10px; font-style: italic; }
		.ta-order-invoiced { opacity: 0.65; background: #f1f5f9 !important; }
		.ta-invoiced-badge { display: inline-block; font-size: 9px; font-weight: 700; padding: 1px 5px; background: #10b981; color: #fff; border-radius: 8px; margin-left: 5px; vertical-align: middle; letter-spacing: .3px; }
		.ta-empty-truck { text-align: center; color: #94a3b8; padding: 16px; font-style: italic; }

		/* Closed trucks */
		.ta-closed-card { opacity: 0.85; }
		.ta-closed-card:hover { opacity: 1; }
		.ta-closed-toggle {
			padding: 8px 14px;
			font-size: 12px;
			font-weight: 600;
			color: #64748b;
			cursor: pointer;
			background: #f8fafc;
			user-select: none;
		}
		.ta-closed-toggle:hover { background: #f1f5f9; color: #475569; }
		.ta-closed-orders-list { border-top: 1px solid #f1f5f9; }


		/* GPS badges */
		.ta-gps-badge {
			padding: 2px 6px;
			border-radius: 4px;
			font-size: 10px;
			font-weight: 700;
			text-transform: uppercase;
			white-space: nowrap;
		}
		.ta-gps-mapped { background: #dcfce7; color: #166534; border: 1px solid #bbf7d0; }
		.ta-gps-missing { background: #f1f5f9; color: #64748b; border: 1px solid #e2e8f0; }
		</style>`;
	}
}

