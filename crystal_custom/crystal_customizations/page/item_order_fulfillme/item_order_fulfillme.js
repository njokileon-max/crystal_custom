frappe.pages['item-order-fulfillme'].on_page_load = function (wrapper) {
	var page = frappe.ui.make_app_page({
		parent: wrapper,
		title: 'Order Fulfillment',
		single_column: true,
	});
	new OrderFulfillmentManager(page);
};

class OrderFulfillmentManager {
	constructor(page) {
		this.page        = page;
		this.active_tab  = 'trucks';
		this.summary_data  = [];
		this.truck_data    = { trucks: [], stock: {} };
		this.customer_data = { trucks: [], stock: {} };
		this.allocations   = {};   // { item_code: { truck_number: qty } }
		this.search_term   = '';
		this._alloc_save_timer = null;
		this.selected_trucks   = new Set();
		this.truck_snapshot    = this._load_snapshot();
		this._closed_trucks    = this._load_closed_trucks();
		this.trucks_subtab     = 'active';
		this._stock_updated_at    = null;
		this._stock_refresh_timer = null;
		this.setup_page();
		this._load_allocations_then_data();
	}

	// Load persisted allocations + closed trucks from server, then fetch order/stock data
	_load_allocations_then_data() {
		Promise.all([
			new Promise(resolve => frappe.call({
				method: 'crystal_custom.crystal_customizations.page.item_order_fulfillme.item_order_fulfillme.get_allocations',
				callback: r => {
					try { this.allocations = JSON.parse(r.message || '{}') || {}; } catch(e) {}
					resolve();
				},
				error: () => resolve(),
			})),
			new Promise(resolve => frappe.call({
				method: 'crystal_custom.crystal_customizations.page.item_order_fulfillme.item_order_fulfillme.get_ofm_closed_trucks',
				callback: r => {
					try {
						const saved = JSON.parse(r.message || '[]');
						this._closed_trucks = new Set(saved);
						localStorage.setItem('crystal_tf_closed_trucks', r.message || '[]');
					} catch(e) {}
					resolve();
				},
				error: () => resolve(),
			})),
		]).then(() => this.load_data());
	}

	_save_allocations() {
		clearTimeout(this._alloc_save_timer);
		this._alloc_save_timer = setTimeout(() => {
			frappe.call({
				method: 'crystal_custom.crystal_customizations.page.item_order_fulfillme.item_order_fulfillme.save_allocations',
				args: { allocations_json: JSON.stringify(this.allocations) },
			});
		}, 800);
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
			label: 'Search', fieldtype: 'Data', fieldname: 'search_query',
			placeholder: 'Truck, order, item, region, sales person…',
			change: () => {
				this.search_term = this.page.fields_dict.search_query.get_value() || '';
				if (this.active_tab === 'trucks') {
					this.container.find('#tf-trucks-pane').html(this._render_trucks_tab());
				} else if (this.active_tab === 'stock') {
					this.container.find('#tf-stock-pane').html(this._render_stock_tab());
				} else if (this.active_tab === 'customers') {
					this.container.find('#tf-customers-pane').html(this._render_customers_tab());
				} else {
					this.container.find('#tf-summary-pane').html(this._render_summary_tab());
				}
				this._attach_events();
			},
		});

		this.page.set_primary_action('Create Requisition', () => this.create_requisition(), 'octicon octicon-plus');
		this.page.add_button('Auto Allocate', () => this.auto_allocate());
		this.page.add_button('Refresh', () => this.load_data(), 'octicon octicon-sync');

		this.container = $('<div class="tf-container"></div>').appendTo(this.page.main);
	}

	// ── Data loading ──────────────────────────────────────────────────────────

	_fmt_updated_at() {
		if (!this._stock_updated_at) return '';
		return 'Stock as of ' + this._stock_updated_at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
	}

	_silent_refresh_stock() {
		if (!this.container.closest('body').length) {
			clearInterval(this._stock_refresh_timer);
			return;
		}
		frappe.call({
			method: 'crystal_custom.crystal_customizations.page.item_order_fulfillme.item_order_fulfillme.get_truck_fulfillment_data',
			callback: r => {
				if (!r.message) return;
				this.truck_data.stock = r.message.stock || {};
				this._stock_updated_at = new Date();
				this.container.find('.tf-stock-ts').text(this._fmt_updated_at());
				if (this.active_tab === 'stock') {
					this.container.find('#tf-stock-pane').html(this._render_stock_tab());
					this._attach_events();
				}
			},
		});
	}

	load_data() {
		if (this._stock_refresh_timer) {
			clearInterval(this._stock_refresh_timer);
			this._stock_refresh_timer = null;
		}
		this.container.html(this._loading_html());

		const from_date = this.page.fields_dict.from_date.get_value();
		const to_date   = this.page.fields_dict.to_date.get_value();

		const prev_stock = this.truck_data ? { ...this.truck_data.stock } : {};

		const region_promise = new Promise(resolve => frappe.call({
			method: 'crystal_custom.crystal_customizations.page.item_order_fulfillme.item_order_fulfillme.get_region_fulfillment_data',
			callback: r => resolve(r.message || { trucks: [], stock: {} }),
			error: () => resolve({ trucks: [], stock: {} }),
		}));

		Promise.all([
			new Promise(resolve => frappe.call({
				method: 'crystal_custom.crystal_customizations.page.item_order_fulfillme.item_order_fulfillme.get_sales_order_fulfillment',
				args: { from_date, to_date },
				callback: r => { this.summary_data = r.message || []; resolve(); },
				error: () => resolve(),
			})),
			new Promise(resolve => frappe.call({
				method: 'crystal_custom.crystal_customizations.page.item_order_fulfillme.item_order_fulfillme.get_truck_fulfillment_data',
				callback: r => { this.truck_data = r.message || { trucks: [], stock: {} }; resolve(); },
				error: () => resolve(),
			})),
			new Promise(resolve => frappe.call({
				method: 'crystal_custom.crystal_customizations.page.item_order_fulfillme.item_order_fulfillme.get_truck_customer_data',
				callback: r => { this.customer_data = r.message || { trucks: [], stock: {} }; resolve(); },
				error: () => resolve(),
			})),
			region_promise,
		]).then(([,,,region_data]) => {
			// Prepend virtual region bucket trucks and merge their stock
			if (region_data.trucks.length) {
				this.truck_data.trucks = [...region_data.trucks, ...this.truck_data.trucks];
				Object.assign(this.truck_data.stock, region_data.stock);
			}
			const changed = Object.keys(this.truck_data.stock).filter(ic => {
				const old_qty = (prev_stock[ic] || {}).available_qty;
				const new_qty = (this.truck_data.stock[ic] || {}).available_qty;
				return old_qty !== undefined && old_qty !== new_qty;
			});
			if (changed.length) {
				frappe.show_alert({
					message: __('Stock levels changed for {0} item(s) — shortages recalculated', [changed.length]),
					indicator: 'orange',
				}, 6);
			}
			// Prune closed trucks (and closed region buckets) that no longer have live data
			const live_truck_nums = new Set(this.truck_data.trucks.map(t => t.truck_number));
			[...this._closed_trucks].forEach(tn => {
				if (!live_truck_nums.has(tn)) this._closed_trucks.delete(tn);
			});
			this._save_closed_trucks();
			this._stock_updated_at = new Date();
			this._stock_refresh_timer = setInterval(() => this._silent_refresh_stock(), 90000);
			this.render();
		});
	}

	// ── Rendering ─────────────────────────────────────────────────────────────

	render() {
		const trucks_badge = this.truck_data.trucks.length;
		const items_badge  = this.summary_data.length;
		const cust_badge   = this.customer_data.trucks.reduce((s, t) => s + t.orders.length, 0);
		const stock_badge  = Object.keys(this._compute_item_summary()).length;

		let html = `${this._styles()}
		<div class="tf-page-intro">
			<div>
				<div class="tf-eyebrow">Dispatch workspace</div>
				<h2>Order fulfilment overview</h2>
				<p>Review demand, allocate available stock, and prepare each truck for dispatch.</p>
			</div>
			<div class="tf-live-status">
				<span class="tf-live-dot"></span>
				<span class="tf-stock-ts">${this._fmt_updated_at()}</span>
			</div>
		</div>
		<div class="tf-tabs">
			<button class="tf-tab-btn ${this.active_tab === 'trucks'    ? 'active' : ''}" data-tab="trucks">
				<span class="tf-tab-icon">&#128666;</span> Trucks
				${trucks_badge ? `<span class="tf-tab-badge">${trucks_badge}</span>` : ''}
			</button>
			<button class="tf-tab-btn ${this.active_tab === 'stock'     ? 'active' : ''}" data-tab="stock">
				<span class="tf-tab-icon">&#9638;</span> Stock Overview
				${stock_badge ? `<span class="tf-tab-badge">${stock_badge}</span>` : ''}
			</button>
			<button class="tf-tab-btn ${this.active_tab === 'customers' ? 'active' : ''}" data-tab="customers">
				<span class="tf-tab-icon">&#9787;</span> Customer View
				${cust_badge ? `<span class="tf-tab-badge">${cust_badge}</span>` : ''}
			</button>
			<button class="tf-tab-btn ${this.active_tab === 'summary'   ? 'active' : ''}" data-tab="summary">
				<span class="tf-tab-icon">&#9776;</span> Item Summary
				${items_badge ? `<span class="tf-tab-badge">${items_badge}</span>` : ''}
			</button>
		</div>
		<div class="tf-tab-content">
			<div class="tf-tab-pane ${this.active_tab === 'trucks'    ? 'active' : ''}" id="tf-trucks-pane">
				${this._render_trucks_tab()}
			</div>
			<div class="tf-tab-pane ${this.active_tab === 'stock'     ? 'active' : ''}" id="tf-stock-pane">
				${this._render_stock_tab()}
			</div>
			<div class="tf-tab-pane ${this.active_tab === 'customers' ? 'active' : ''}" id="tf-customers-pane">
				${this._render_customers_tab()}
			</div>
			<div class="tf-tab-pane ${this.active_tab === 'summary'   ? 'active' : ''}" id="tf-summary-pane">
				${this._render_summary_tab()}
			</div>
		</div>`;

		this.container.html(html);
		this._attach_events();
	}

	// ── Trucks Tab ────────────────────────────────────────────────────────────

	_truck_has_shortage(truck) {
		return truck.items.some(item => {
			const alloc = (this.allocations[item.item_code] || {})[truck.truck_number] || 0;
			return item.required_qty > alloc;
		});
	}

	_render_trucks_tab() {
		const all_trucks = this.truck_data.trucks;

		// Search mode: flat results table showing which truck each order is on
		if (this.search_term) {
			return this._render_truck_search_results(all_trucks);
		}

		return this._render_trucks_subtabs(all_trucks);
	}

	_render_truck_search_results(all_trucks) {
		const q       = this.search_term.toLowerCase();
		const matches = [];

		all_trucks.forEach(truck => {
			const tn        = truck.truck_number;
			const is_closed = this._closed_trucks.has(tn);
			const is_region = !!truck.is_region_bucket;
			const status    = is_region ? 'Pre-Fulfilment' : (is_closed ? 'Dispatched' : 'Active');
			const status_color = is_region ? '#0d9488' : (is_closed ? '#64748b' : '#8b5cf6');

			// Items live at truck level in the Trucks tab; check them once per truck
			const truck_matched_items = (truck.items || []).filter(i =>
				(i.item_code || '').toLowerCase().includes(q) ||
				(i.item_name || '').toLowerCase().includes(q)
			);
			const truck_item_hit = truck_matched_items.length > 0;

			(truck.orders || []).forEach(o => {
				// Customer-view data attaches items per order; truck-view data does not
				const order_matched_items = (o.items || []).filter(i =>
					(i.item_code || '').toLowerCase().includes(q) ||
					(i.item_name || '').toLowerCase().includes(q)
				);
				const hit =
					(tn                || '').toLowerCase().includes(q) ||
					(o.name            || '').toLowerCase().includes(q) ||
					(o.customer_name   || '').toLowerCase().includes(q) ||
					(o.delivery_region || '').toLowerCase().includes(q) ||
					(o.sales_persons   || '').toLowerCase().includes(q) ||
					order_matched_items.length > 0 ||
					truck_item_hit;
				const matched_items = order_matched_items.length ? order_matched_items : truck_matched_items;
				if (hit) matches.push({ o, tn, is_region, status, status_color, matched_items });
			});
		});

		if (!matches.length) {
			return `<div class="alert alert-info" style="margin-top:20px;">
				<strong>No results for "${frappe.utils.escape_html(this.search_term)}"</strong>
				— try an order number, customer name, truck number, item code, or item name.
			</div>`;
		}

		const rows = matches.map(({ o, tn, is_region, status, status_color, matched_items }) => {
			const item_badges = matched_items.map(i =>
				`<span style="font-size:10px;background:#dbeafe;color:#1e40af;padding:1px 5px;border-radius:3px;margin-right:3px;">${frappe.utils.escape_html(i.item_name || i.item_code)}</span>`
			).join('');
			const truck_cell = is_region
				? `<span style="color:#94a3b8;font-size:12px;">No truck yet</span>`
				: `<strong style="color:#667eea;">${frappe.utils.escape_html(tn)}</strong>`;
			const region_cell = is_region
				? `<strong style="color:#0d9488;">${frappe.utils.escape_html(o.delivery_region || tn)}</strong>`
				: frappe.utils.escape_html(o.delivery_region || '');
			return `<tr>
				<td>
					<a href="/app/sales-order/${o.name}" target="_blank" class="tf-order-link">${frappe.utils.escape_html(o.name)}</a>
					${item_badges ? `<div style="margin-top:3px;">${item_badges}</div>` : ''}
				</td>
				<td>${frappe.utils.escape_html(o.customer_name || '')}</td>
				<td>${truck_cell}</td>
				<td>${region_cell}</td>
				<td><span class="tf-status-badge" style="background:${status_color};">${status}</span></td>
			</tr>`;
		}).join('');

		return `
		<div style="margin-bottom:12px;color:#64748b;font-size:13px;">
			${matches.length} result${matches.length !== 1 ? 's' : ''} for
			<strong>"${frappe.utils.escape_html(this.search_term)}"</strong>
		</div>
		<table class="table table-bordered tf-table">
			<thead><tr>
				<th>Sales Order</th>
				<th>Customer</th>
				<th>Truck</th>
				<th>Delivery Region</th>
				<th>Status</th>
			</tr></thead>
			<tbody>${rows}</tbody>
		</table>`;
	}

	_render_trucks_subtabs(all_trucks) {
		if (!all_trucks.length) {
			return `<div class="alert alert-info" style="margin-top:20px;">
				<strong>No active trucks with assigned orders</strong> — assign orders to trucks in the <a href="/app/sales-order-truck-as-v2">Truck Assignment</a> page first.
			</div>`;
		}

		const region_buckets = all_trucks.filter(t =>  t.is_region_bucket);
		let   trucks         = all_trucks.filter(t => !t.is_region_bucket);

		trucks = [...trucks].sort((a, b) => {
			const a_short = a.items.length > 0 && this._truck_has_shortage(a);
			const b_short = b.items.length > 0 && this._truck_has_shortage(b);
			if (a_short !== b_short) return b_short ? 1 : -1;
			return (a.truck_number || '').localeCompare(b.truck_number || '');
		});

		const open_trucks    = trucks.filter(t => !this._closed_trucks.has(t.truck_number));
		const closed_trucks  = trucks.filter(t =>  this._closed_trucks.has(t.truck_number));
		const open_regions   = region_buckets.filter(t => !this._closed_trucks.has(t.truck_number));
		const closed_regions = region_buckets.filter(t =>  this._closed_trucks.has(t.truck_number));

		const item_summary = this._compute_item_summary();
		const total_items  = Object.keys(item_summary).length;
		const items_ok     = Object.values(item_summary).filter(s => s.total_short <= 0).length;
		const items_short  = total_items - items_ok;
		const new_count    = this._count_new_orders();

		const active_count     = open_trucks.length + open_regions.length;
		const dispatched_count = closed_trucks.length + closed_regions.length;
		const is_active        = (this.trucks_subtab !== 'dispatched');

		const active_html = `
		<div class="tf-kpi-row">
			${this._kpi('Active Trucks', open_trucks.length, '#8b5cf6')}
			${this._kpi('Items Needed', total_items, '#667eea')}
			${this._kpi('Fully Stocked', items_ok, '#10b981')}
			${this._kpi('With Shortages', items_short, items_short > 0 ? '#ef4444' : '#9ca3af')}
		</div>
		<div class="tf-truck-actions">
			<button class="btn btn-sm btn-default tf-mr-selected-btn">&#128203; MR for Selected Trucks</button>
			${new_count > 0
				? `<button class="btn btn-sm tf-mr-new-btn" style="background:#10b981;color:#fff;border-color:#10b981;">&#9733; MR for ${new_count} New Order${new_count !== 1 ? 's' : ''}</button>`
				: ''}
			<button class="btn btn-sm btn-default tf-mark-reviewed-btn">&#10003; Mark All as Reviewed</button>
			${new_count > 0 ? `<span class="tf-new-notice">${new_count} newly added order${new_count !== 1 ? 's' : ''} highlighted in green</span>` : ''}
		</div>
		${open_regions.length ? `
		<div class="tf-section" style="margin-bottom:24px;">
			<div class="tf-section-header" style="background:#0f766e;">
				&#128205; Pre-Fulfilment Regions (${open_regions.length})
				<span class="tf-header-note" style="color:#99f6e4;">Orders without a truck assignment yet — prepare stock for these regions</span>
			</div>
			<div class="tf-trucks-grid">
				${open_regions.map(t => this._render_region_bucket_card(t, item_summary, false)).join('')}
			</div>
		</div>` : ''}
		<div class="tf-section">
			<div class="tf-section-header">
				Active Trucks (${open_trucks.length})
				<span class="tf-header-note">Allocate stock to trucks using the inputs in each truck card</span>
			</div>
			<div class="tf-trucks-grid" id="tf-trucks-grid">
				${open_trucks.length
					? open_trucks.map(t => this._render_truck_card(t, item_summary, false)).join('')
					: '<div class="tf-empty" style="padding:20px;">All trucks marked as complete — check the Dispatched tab.</div>'}
			</div>
		</div>`;

		const dispatched_html = `
		${closed_regions.length ? `
		<div class="tf-section" style="margin-bottom:24px;">
			<div class="tf-section-header" style="background:#134e4a;color:#a7f3d0;border-bottom:none;">
				&#128205; Completed Pre-Fulfilment Regions (${closed_regions.length})
			</div>
			<div class="tf-trucks-grid" style="margin-top:12px;">
				${closed_regions.map(t => this._render_region_bucket_card(t, item_summary, true)).join('')}
			</div>
		</div>` : ''}
		<div class="tf-section">
			<div class="tf-section-header" style="background:#334155;color:#f1f5f9;border-bottom:none;">
				&#128666; Dispatched Trucks (${closed_trucks.length})
				<span class="tf-header-note" style="color:#94a3b8;">Trucks marked as done — reopen to move back to Active</span>
			</div>
			<div class="tf-trucks-grid" style="margin-top:12px;">
				${closed_trucks.length
					? closed_trucks.map(t => this._render_truck_card(t, item_summary, true)).join('')
					: '<div class="tf-empty" style="padding:20px;">No dispatched trucks yet.</div>'}
			</div>
		</div>`;

		return `
		<div class="tf-subtabs">
			<button class="tf-subtab-btn ${is_active ? 'active' : ''}" data-subtab="active">
				Active
				${active_count ? `<span class="tf-subtab-badge">${active_count}</span>` : ''}
			</button>
			<button class="tf-subtab-btn ${!is_active ? 'active' : ''}" data-subtab="dispatched">
				Dispatched
				${dispatched_count ? `<span class="tf-subtab-badge" style="background:#64748b;">${dispatched_count}</span>` : ''}
			</button>
		</div>
		${is_active ? active_html : dispatched_html}`;
	}

	_compute_item_summary() {
		const summary = {};

		this.truck_data.trucks.filter(t => !this._closed_trucks.has(t.truck_number)).forEach(truck => {
			truck.items.forEach(item => {
				if (!summary[item.item_code]) {
					summary[item.item_code] = {
						item_code:      item.item_code,
						item_name:      item.item_name,
						uom:            item.uom,
						total_required: 0,
						in_stock:       (this.truck_data.stock[item.item_code] || {}).available_qty || 0,
					};
				}
				summary[item.item_code].total_required += item.required_qty;
			});
		});

		Object.keys(summary).forEach(ic => {
			const s       = summary[ic];
			const alloc   = this.allocations[ic] || {};
			s.total_allocated = Object.values(alloc).reduce((a, b) => a + b, 0);
			s.remaining_stock = Math.max(0, s.in_stock - s.total_allocated);
			s.total_short     = Math.max(0, s.total_required - s.in_stock);
		});

		return summary;
	}

	_get_available_for_truck(item_code, truck_number) {
		const in_stock = (this.truck_data.stock[item_code] || {}).available_qty || 0;
		const alloc    = this.allocations[item_code] || {};
		const others   = Object.entries(alloc)
			.filter(([tn]) => tn !== truck_number)
			.reduce((s, [, v]) => s + v, 0);
		return Math.max(0, in_stock - others);
	}

	_render_item_overview(item_summary) {
		const items = Object.values(item_summary).sort((a, b) => b.total_short - a.total_short);

		if (!items.length) return '<div class="tf-empty">No items.</div>';

		let html = `<table class="table table-bordered tf-table">
			<thead><tr>
				<th>Item Code</th><th>Description</th>
				<th class="tf-r">Total Needed</th>
				<th class="tf-r">In Stock</th>
				<th class="tf-r">Allocated</th>
				<th class="tf-r">Remaining</th>
				<th class="tf-r">Short</th>
			</tr></thead><tbody>`;

		items.forEach(s => {
			const ic = this._sid(s.item_code);
			html += `<tr>
				<td><strong>${frappe.utils.escape_html(s.item_code)}</strong></td>
				<td>${frappe.utils.escape_html(s.item_name)}</td>
				<td class="tf-r">${s.total_required.toFixed(2)} ${s.uom}</td>
				<td class="tf-r ${s.in_stock < s.total_required ? 'tf-warn' : 'tf-ok'}">
					${s.in_stock.toFixed(2)}
				</td>
				<td class="tf-r" id="tf-ov-alloc-${ic}">${s.total_allocated.toFixed(2)}</td>
				<td class="tf-r" id="tf-ov-rem-${ic}">${s.remaining_stock.toFixed(2)}</td>
				<td class="tf-r ${s.total_short > 0 ? 'tf-short' : 'tf-ok'}" id="tf-ov-short-${ic}">
					${s.total_short > 0 ? `<strong>${s.total_short.toFixed(2)}</strong>` : '—'}
				</td>
			</tr>`;
		});

		html += '</tbody></table>';
		return html;
	}

	_render_truck_card(truck, item_summary, is_closed = false) {
		if (truck.is_region_bucket) return this._render_region_bucket_card(truck, item_summary);
		const tn  = truck.truck_number;
		const sid = this._sid(tn);

		// Build item → [customer names] map for this truck from customer_data
		const cv_truck = (this.customer_data.trucks || []).find(t => t.truck_number === tn) || { orders: [] };
		const item_customers = {};
		cv_truck.orders.forEach(order => {
			(order.items || []).forEach(item => {
				if (item.required_qty > 0) {
					if (!item_customers[item.item_code]) item_customers[item.item_code] = [];
					item_customers[item.item_code].push(order.customer_name);
				}
			});
		});

		let fully_allocated = true;
		let any_items = truck.items.length > 0;

		let rows = '';
		truck.items.forEach(item => {
			const ic          = item.item_code;
			const alloc_map   = this.allocations[ic] || {};
			const truck_alloc = alloc_map[tn] || 0;
			const avail       = this._get_available_for_truck(ic, tn);
			const max_alloc   = Math.min(item.required_qty, truck_alloc + avail);
			const short       = Math.max(0, item.required_qty - truck_alloc);
			if (short > 0) fully_allocated = false;

			const isic = this._sid(ic);
			const affected = short > 0 ? (item_customers[ic] || []) : [];

			rows += `<tr>
				<td><strong>${frappe.utils.escape_html(ic)}</strong></td>
				<td class="tf-item-name">${frappe.utils.escape_html(item.item_name)}</td>
				<td class="tf-r">${item.required_qty.toFixed(2)} ${item.uom}</td>
				<td class="tf-r">
					<input type="number" class="tf-alloc-input"
					       data-truck="${frappe.utils.escape_html(tn)}"
					       data-item="${frappe.utils.escape_html(ic)}"
					       value="${truck_alloc}"
					       min="0" max="${max_alloc.toFixed(3)}" step="0.001">
				</td>
				<td class="tf-r tf-short-cell ${short > 0 ? 'tf-short' : 'tf-ok'}"
				    id="tf-short-${sid}-${isic}">
					${short > 0 ? `<strong>${short.toFixed(2)}</strong>
						${affected.length ? `<div class="tf-affected-custs">${affected.map(c => frappe.utils.escape_html(c)).join(', ')}</div>` : ''}` : '—'}
				</td>
			</tr>`;
		});

		const status_label = !any_items ? 'No Items'
			: fully_allocated ? 'Fully Allocated'
			: 'Has Shortages';
		const status_color = !any_items ? '#9ca3af'
			: fully_allocated ? '#10b981'
			: '#ef4444';

		const orders_html = (truck.orders || []).map(o => {
			const is_new = this._is_order_new(tn, o.name);
			return `
			<div class="tf-order-row${o.paint_notes ? ' tf-order-row-paint' : ''}${is_new ? ' tf-order-row-new' : ''}">
				<div style="flex:1;min-width:0;">
					<a href="/app/sales-order/${o.name}" target="_blank" class="tf-order-link">${o.name}</a>
					${is_new ? '<span class="tf-new-badge">NEW</span>' : ''}
					<span class="tf-order-cust">${frappe.utils.escape_html(o.customer_name)}</span>
					${o.paint_notes ? `<span class="tf-paint-warn-badge">&#9888; Paint Note</span>` : ''}
					${o.paint_notes ? `<div class="tf-paint-notes-banner">&#127758; <strong>Colour / Paint:</strong> ${frappe.utils.escape_html(o.paint_notes)}</div>` : ''}
				</div>
				<button class="btn btn-xs btn-danger btn-remove-order"
				        data-order="${o.name}" data-truck="${frappe.utils.escape_html(tn)}"
				        title="Remove from truck">Remove</button>
			</div>`;
		}).join('');

		const truck_new_count = (truck.orders || []).filter(o => this._is_order_new(tn, o.name)).length;

		return `
		<div class="tf-truck-card" style="${is_closed ? 'opacity:0.75;' : ''}">
			<div class="tf-truck-head" style="${is_closed ? 'background:#334155;' : ''}">
				<div style="display:flex;align-items:center;gap:8px;">
					<input type="checkbox" class="tf-truck-chk"
					       data-truck="${frappe.utils.escape_html(tn)}"
					       ${this.selected_trucks.has(tn) ? 'checked' : ''}
					       style="width:15px;height:15px;accent-color:#667eea;cursor:pointer;flex-shrink:0;">
					<div>
						<span class="tf-truck-num">${frappe.utils.escape_html(tn)}</span>
						<span class="tf-truck-meta">
							${truck.order_count} order${truck.order_count !== 1 ? 's' : ''}
							${truck.total_weight ? ` &nbsp;·&nbsp; ${truck.total_weight.toFixed(0)} kg` : ''}
							${truck_new_count > 0 ? ` &nbsp;·&nbsp; <span style="color:#10b981;font-weight:700;">${truck_new_count} new</span>` : ''}
						</span>
						${truck.delivery_regions ? `<span class="tf-truck-region-tag">&#128205; ${frappe.utils.escape_html(truck.delivery_regions)}</span>` : ''}
					</div>
				</div>
				<div style="display:flex;align-items:center;gap:6px;">
					<button class="btn btn-xs btn-default tf-truck-mr-btn" data-truck="${frappe.utils.escape_html(tn)}" title="Create MR for this truck's shortages">&#128203; MR</button>
					${is_closed
						? `<button class="btn btn-xs tf-truck-reopen-btn" data-truck="${frappe.utils.escape_html(tn)}" style="background:#fef9c3;color:#854d0e;border-color:#fde68a;" title="Reopen this truck">&#8635; Reopen</button>`
						: `<button class="btn btn-xs tf-truck-close-btn" data-truck="${frappe.utils.escape_html(tn)}" style="background:#dcfce7;color:#166534;border-color:#86efac;" title="Mark truck as complete">&#10003; Done</button>`
					}
					<span class="tf-status-badge" id="tf-status-${sid}" style="background:${is_closed ? '#94a3b8' : status_color}">
						${is_closed ? 'Completed' : status_label}
					</span>
				</div>
			</div>

			${truck.orders && truck.orders.length ? `
			<div class="tf-orders-section">
				<div class="tf-orders-toggle" data-sid="${sid}">
					▸ Orders in this truck (${truck.orders.length})
				</div>
				<div class="tf-orders-list" id="tf-orders-list-${sid}" style="display:none;">
					${orders_html}
				</div>
			</div>` : ''}

			${any_items ? `
			<table class="tf-card-table">
				<thead><tr>
					<th>Item</th><th>Name</th>
					<th class="tf-r">Required</th>
					<th class="tf-r">From Stock</th>
					<th class="tf-r">Short</th>
				</tr></thead>
				<tbody>${rows}</tbody>
			</table>` : '<div class="tf-empty">No pending items in this truck.</div>'}
		</div>`;
	}

	_render_region_bucket_card(truck, item_summary, is_closed = false) {
		const tn  = truck.truck_number;
		const sid = this._sid(tn);
		const region = truck.region_label || tn;

		// Build item → [customer names] map from per-order item data
		const item_customers = {};
		(truck.orders || []).forEach(order => {
			(order.items || []).forEach(item => {
				if (item.required_qty > 0) {
					if (!item_customers[item.item_code]) item_customers[item.item_code] = [];
					item_customers[item.item_code].push(order.customer_name);
				}
			});
		});

		let fully_stocked = true;
		let rows = '';
		truck.items.forEach(item => {
			const ic       = item.item_code;
			const stock    = (this.truck_data.stock[item.item_code] || {}).available_qty || 0;
			const short    = Math.max(0, item.required_qty - stock);
			if (short > 0) fully_stocked = false;
			const affected = short > 0 ? (item_customers[ic] || []) : [];
			const isic = this._sid(ic);
			rows += `<tr>
				<td><strong>${frappe.utils.escape_html(ic)}</strong></td>
				<td class="tf-item-name">${frappe.utils.escape_html(item.item_name)}</td>
				<td class="tf-r">${item.required_qty.toFixed(2)} ${item.uom}</td>
				<td class="tf-r">${stock.toFixed(2)}</td>
				<td class="tf-r tf-short-cell ${short > 0 ? 'tf-short' : 'tf-ok'}">
					${short > 0 ? `<strong>${short.toFixed(2)}</strong>
						${affected.length ? `<div class="tf-affected-custs">${affected.map(c => frappe.utils.escape_html(c)).join(', ')}</div>` : ''}` : '—'}
				</td>
			</tr>`;
		});

		const orders_html = (truck.orders || []).map(o => `
			<div class="tf-order-row">
				<div style="flex:1;min-width:0;">
					<a href="/app/sales-order/${o.name}" target="_blank" class="tf-order-link">${o.name}</a>
					<span class="tf-order-cust">${frappe.utils.escape_html(o.customer_name)}</span>
					${o.paint_notes ? `<span class="tf-paint-warn-badge">&#9888; Paint Note</span>` : ''}
					${o.paint_notes ? `<div class="tf-paint-notes-banner">&#127758; <strong>Colour / Paint:</strong> ${frappe.utils.escape_html(o.paint_notes)}</div>` : ''}
				</div>
			</div>`).join('');

		const status_label = fully_stocked ? 'In Stock' : 'Has Shortages';
		const status_color = fully_stocked ? '#10b981' : '#ef4444';

		return `
		<div class="tf-truck-card" style="border-color:#0d9488;${is_closed ? 'opacity:0.75;' : ''}">
			<div class="tf-truck-head" style="background:${is_closed ? '#134e4a' : '#0f766e'};">
				<div style="display:flex;align-items:center;gap:8px;">
					<span style="font-size:18px;">&#128205;</span>
					<div>
						<span class="tf-truck-num">${frappe.utils.escape_html(region)}</span>
						<span class="tf-truck-meta">
							${truck.order_count} order${truck.order_count !== 1 ? 's' : ''} &nbsp;·&nbsp;
							<em>Pre-fulfilment — no truck assigned yet</em>
						</span>
					</div>
				</div>
				<div style="display:flex;align-items:center;gap:6px;">
					<button class="btn btn-xs btn-default tf-truck-mr-btn" data-truck="${frappe.utils.escape_html(tn)}" title="Create MR for this region's shortages">&#128203; MR</button>
					${is_closed
						? `<button class="btn btn-xs tf-region-reopen-btn" data-truck="${frappe.utils.escape_html(tn)}" style="background:#fef9c3;color:#854d0e;border-color:#fde68a;">&#8635; Reopen</button>`
						: `<button class="btn btn-xs tf-region-close-btn" data-truck="${frappe.utils.escape_html(tn)}" style="background:#ccfbf1;color:#134e4a;border-color:#5eead4;">&#10003; Done</button>`
					}
					<span class="tf-status-badge" style="background:${is_closed ? '#94a3b8' : status_color}">${is_closed ? 'Completed' : status_label}</span>
				</div>
			</div>

			${truck.orders && truck.orders.length ? `
			<div class="tf-orders-section">
				<div class="tf-orders-toggle" data-sid="${sid}">
					▸ Orders in this region (${truck.orders.length})
				</div>
				<div class="tf-orders-list" id="tf-orders-list-${sid}" style="display:none;">
					${orders_html}
				</div>
			</div>` : ''}

			${truck.items.length ? `
			<table class="tf-card-table">
				<thead><tr>
					<th>Item</th><th>Name</th>
					<th class="tf-r">Required</th>
					<th class="tf-r">In Stock</th>
					<th class="tf-r">Short</th>
				</tr></thead>
				<tbody>${rows}</tbody>
			</table>` : '<div class="tf-empty">No pending items.</div>'}
		</div>`;
	}

	_get_cv_trucks_and_stock() {
		return {
			trucks: (this.customer_data.trucks || []).filter(t => !this._closed_trucks.has(t.truck_number)),
			stock:  this.customer_data.stock  || {},
		};
	}

	_print_customers_tab() {
		const { trucks } = this._get_cv_trucks_and_stock();
		const today = frappe.datetime.str_to_user(frappe.datetime.get_today());

		let truck_blocks = '';
		trucks.forEach(truck => {
			const tn = truck.truck_number;
			let cust_blocks = '';

			(truck.orders || []).forEach(order => {
				const item_rows = (order.items || []).map((item, idx) => {
					const ic        = item.item_code;
					const alloc     = (this.allocations[ic] || {})[tn] || 0;
					const covered   = Math.min(item.required_qty, alloc);
					const short     = Math.max(0, item.required_qty - alloc);
					const pct       = item.required_qty > 0
						? Math.min(100, Math.round((covered / item.required_qty) * 100))
						: 0;
					return `<tr>
						<td>${idx + 1}</td>
						<td><strong>${frappe.utils.escape_html(ic)}</strong></td>
						<td>${frappe.utils.escape_html(item.item_name)}</td>
						<td style="text-align:right;">${item.required_qty.toFixed(2)} ${item.uom}</td>
						<td style="text-align:right;">${alloc.toFixed(2)}</td>
						<td style="text-align:right;color:${short > 0 ? '#dc2626' : '#059669'};">
							${short > 0 ? `<strong>${short.toFixed(2)}</strong>` : '—'}
						</td>
						<td style="text-align:center;">${pct}%</td>
						<td style="text-align:center;">___________</td>
					</tr>`;
				}).join('');

				const all_covered = (order.items || []).every(i => {
					const alloc = (this.allocations[i.item_code] || {})[tn] || 0;
					return alloc >= i.required_qty;
				});

				cust_blocks += `
				<div class="cv-cust-block${order.paint_notes ? ' cv-cust-block-paint' : ''}">
					<div class="cv-cust-head">
						<span class="cv-cust-name">${frappe.utils.escape_html(order.customer_name)}</span>
						<span class="cv-cust-meta">
							${frappe.utils.escape_html(order.name)}
							${order.grand_total ? ` &nbsp;·&nbsp; ${format_currency(order.grand_total, null, 0)}` : ''}
							&nbsp;·&nbsp; <strong style="color:${all_covered ? '#059669' : '#d97706'}">
								${all_covered ? 'Fully Covered' : 'Partial / Short'}
							</strong>
						</span>
					</div>
					${order.paint_notes ? `
					<div class="cv-paint-alert">
						&#9888;&nbsp;<strong>PAINT / COLOUR NOTE:</strong>&nbsp;${frappe.utils.escape_html(order.paint_notes)}
					</div>` : ''}
					<table>
						<thead><tr>
							<th>#</th><th>Item Code</th><th>Description</th>
							<th style="text-align:right;">Required</th>
							<th style="text-align:right;">Allocated</th>
							<th style="text-align:right;">Short</th>
							<th style="text-align:center;">Coverage</th>
							<th style="text-align:center;">Received ✓</th>
						</tr></thead>
						<tbody>${item_rows}</tbody>
					</table>
					<div class="cv-sig">Received by: ___________________________ &nbsp;&nbsp; Signature: ___________________________</div>
				</div>`;
			});

			truck_blocks += `
			<div class="cv-truck-block">
				<div class="cv-truck-head">
					&#128666; ${frappe.utils.escape_html(tn)}
					<span style="font-size:12px;font-weight:400;margin-left:12px;">
						${(truck.orders || []).length} customer${(truck.orders || []).length !== 1 ? 's' : ''}
					</span>
				</div>
				${cust_blocks}
			</div>`;
		});

		const html = `<!DOCTYPE html><html>
<head><meta charset="utf-8"><title>Customer Order View</title>
<style>
  body{font-family:Arial,sans-serif;font-size:12px;margin:20px;color:#111;}
  h2{margin:0 0 4px;}
  .meta{color:#555;margin-bottom:20px;font-size:11px;}
  table{border-collapse:collapse;width:100%;margin-bottom:4px;}
  th,td{border:1px solid #bbb;padding:6px 9px;}
  th{background:#1e293b;color:#fff;text-align:left;font-size:11px;}
  .cv-truck-block{margin-bottom:28px;page-break-before:auto;}
  .cv-truck-head{background:#334155;color:#f1f5f9;padding:10px 14px;font-size:15px;font-weight:700;border-radius:4px 4px 0 0;margin-bottom:0;}
  .cv-cust-block{margin-bottom:20px;border:1px solid #e2e8f0;border-radius:0 0 4px 4px;page-break-inside:avoid;}
  .cv-cust-block-paint{border-color:#f59e0b !important;}
  .cv-cust-head{background:#f8fafc;padding:8px 12px;display:flex;justify-content:space-between;align-items:center;border-bottom:1px solid #e2e8f0;}
  .cv-cust-name{font-size:14px;font-weight:700;}
  .cv-cust-meta{font-size:11px;color:#475569;}
  .cv-paint-alert{background:#fef3c7;border-bottom:1px solid #fcd34d;padding:8px 12px;font-size:12px;color:#78350f;font-weight:600;}
  .cv-sig{padding:8px 12px;font-size:11px;color:#475569;border-top:1px dashed #cbd5e1;margin-top:4px;}
  @media print{.no-print{display:none}body{margin:10px}.cv-truck-block{page-break-before:always;}.cv-truck-block:first-child{page-break-before:auto;}}
</style>
</head><body>
<button class="no-print" onclick="window.print()" style="float:right;padding:6px 16px;background:#1e293b;color:#fff;border:none;border-radius:4px;cursor:pointer;">Print</button>
<h2>CUSTOMER ORDER VIEW</h2>
<div class="meta">Date: ${today} &nbsp;|&nbsp; Trucks: ${trucks.length} &nbsp;|&nbsp; Customers: ${trucks.reduce((s, t) => s + (t.orders || []).length, 0)}</div>
${truck_blocks}
<p style="margin-top:20px;font-size:10px;color:#888;">Generated: ${today} &nbsp;·&nbsp; Crystal Customs</p>
</body></html>`;

		const w = window.open('', '_blank');
		w.document.write(html);
		w.document.close();
	}

	_download_customers_tab() {
		const { trucks } = this._get_cv_trucks_and_stock();
		const today = frappe.datetime.get_today();

		let rows = '';
		trucks.forEach(truck => {
			const tn = truck.truck_number;
			(truck.orders || []).forEach(order => {
				(order.items || []).forEach(item => {
					const ic    = item.item_code;
					const alloc = (this.allocations[ic] || {})[tn] || 0;
					const short = Math.max(0, item.required_qty - alloc);
					const pct   = item.required_qty > 0
						? Math.min(100, Math.round((Math.min(item.required_qty, alloc) / item.required_qty) * 100))
						: 0;
					rows += `<tr>
						<td>${frappe.utils.escape_html(tn)}</td>
						<td>${frappe.utils.escape_html(order.name)}</td>
						<td>${frappe.utils.escape_html(order.customer_name)}</td>
						<td>${frappe.utils.escape_html(ic)}</td>
						<td>${frappe.utils.escape_html(item.item_name)}</td>
						<td>${item.required_qty.toFixed(2)}</td>
						<td>${item.uom}</td>
						<td>${alloc.toFixed(2)}</td>
						<td>${short > 0 ? short.toFixed(2) : 0}</td>
						<td>${pct}</td>
					</tr>`;
				});
			});
		});

		const html = `<html xmlns:o="urn:schemas-microsoft-com:office:office"
			xmlns:x="urn:schemas-microsoft-com:office:excel"
			xmlns="http://www.w3.org/TR/REC-html40">
<head><meta charset="utf-8">
<style>
	table{border-collapse:collapse}
	th,td{border:1px solid #ddd;padding:7px 10px;font-family:sans-serif;font-size:12px}
	th{background:#1e293b;color:#fff;font-weight:bold}
</style></head><body>
<h2 style="font-family:sans-serif">Customer Order View — ${today}</h2>
<table>
	<thead><tr>
		<th>Truck</th><th>Order</th><th>Customer</th>
		<th>Item Code</th><th>Description</th>
		<th>Required Qty</th><th>UOM</th>
		<th>Allocated</th><th>Short</th><th>Coverage %</th>
	</tr></thead>
	<tbody>${rows}</tbody>
</table>
</body></html>`;

		const blob = new Blob([html], { type: 'application/vnd.ms-excel;charset=utf-8;' });
		const a    = document.createElement('a');
		a.href     = URL.createObjectURL(blob);
		a.download = `Customer_Order_View_${today}.xls`;
		a.style.display = 'none';
		document.body.appendChild(a);
		a.click();
		document.body.removeChild(a);
		frappe.show_alert({ message: __('Customer view downloaded'), indicator: 'green' });
	}

	// ── Stock Overview Tab ────────────────────────────────────────────────────

	_render_stock_tab() {
		const item_summary = this._compute_item_summary();

		if (this.search_term) {
			const q = this.search_term.toLowerCase();
			const filtered = {};
			Object.entries(item_summary).forEach(([ic, s]) => {
				if (ic.toLowerCase().includes(q) || (s.item_name || '').toLowerCase().includes(q))
					filtered[ic] = s;
			});
			return this._render_stock_tab_html(filtered);
		}

		return this._render_stock_tab_html(item_summary);
	}

	_render_stock_tab_html(item_summary) {
		const items       = Object.values(item_summary).sort((a, b) => b.total_short - a.total_short);
		const total_items = items.length;
		const items_ok    = items.filter(s => s.total_short <= 0).length;
		const items_short = total_items - items_ok;

		if (!items.length) {
			return `<div class="alert alert-info" style="margin-top:20px;">
				<strong>${this.search_term ? 'No items match your search.' : 'No items — assign orders to trucks first.'}</strong>
			</div>`;
		}

		return `
		<div style="display:flex;align-items:center;gap:14px;margin-bottom:14px;font-size:12px;color:#6b7280;">
			<span>${total_items} items &nbsp;·&nbsp; <strong style="color:#10b981;">${items_ok} stocked</strong>${items_short ? ` &nbsp;·&nbsp; <strong style="color:#ef4444;">${items_short} short</strong>` : ''}</span>
			<span class="tf-stock-ts" style="margin-left:auto;">${this._fmt_updated_at()}</span>
			<button class="btn btn-xs btn-default tf-refresh-stock-btn">&#8635; Refresh Stock</button>
		</div>
		<div id="tf-item-overview">
			${this._render_item_overview(item_summary)}
		</div>`;
	}

	// ── Customer View Tab ─────────────────────────────────────────────────────

	_render_customers_tab() {
		let trucks = (this.customer_data.trucks || []).filter(t => !this._closed_trucks.has(t.truck_number));
		const stock = this.customer_data.stock || {};

		if (this.search_term) {
			const q = this.search_term.toLowerCase();
			trucks = trucks.map(t => ({
				...t,
				orders: t.orders.filter(o =>
					(o.name          || '').toLowerCase().includes(q) ||
					(o.customer_name || '').toLowerCase().includes(q) ||
					(o.customer      || '').toLowerCase().includes(q) ||
					(o.items || []).some(i =>
						(i.item_code || '').toLowerCase().includes(q) ||
						(i.item_name || '').toLowerCase().includes(q)
					)
				),
			})).filter(t => t.orders.length);
		}

		if (!trucks.length) {
			return `<div class="alert alert-info" style="margin-top:20px;">
				<strong>${this.search_term ? 'No customers match your search.' : 'No truck-assigned orders.'}</strong>
			</div>`;
		}

		const total_orders = trucks.reduce((s, t) => s + t.orders.length, 0);
		let html = `
		<div style="display:flex;align-items:center;gap:14px;margin-bottom:14px;font-size:12px;color:#6b7280;">
			<span>${trucks.length} truck${trucks.length !== 1 ? 's' : ''} &nbsp;·&nbsp; ${total_orders} customer${total_orders !== 1 ? 's' : ''}</span>
			<div style="margin-left:auto;display:flex;gap:8px;">
				<button class="btn btn-xs btn-default tf-cv-print-btn">&#128438; Print</button>
				<button class="btn btn-xs btn-default tf-cv-dl-btn">&#8659; Excel</button>
			</div>
		</div>`;

		// ── APS summary section ──────────────────────────────────────────────
		const aps_entries = [];
		trucks.forEach(truck => {
			truck.orders.forEach(order => {
				(order.items || []).forEach(i => {
					if ((i.item_name || i.item_code || '').toUpperCase().includes('APS')) {
						aps_entries.push({
							truck: truck.truck_number,
							order: order.name,
							customer: order.customer_name,
							item_code: i.item_code,
							item_name: i.item_name || i.item_code,
							qty: i.required_qty,
							uom: i.uom || '',
						});
					}
				});
			});
		});

		if (aps_entries.length) {
			html += `
			<div style="margin-bottom:20px;border:2px solid #f59e0b;border-radius:8px;overflow:hidden;">
				<div style="background:#fef3c7;padding:8px 14px;font-size:12px;font-weight:700;color:#92400e;display:flex;align-items:center;gap:8px;">
					&#9888; APS Items &nbsp;·&nbsp; ${aps_entries.length} line${aps_entries.length !== 1 ? 's' : ''} across ${new Set(aps_entries.map(e => e.order)).size} order${new Set(aps_entries.map(e => e.order)).size !== 1 ? 's' : ''}
				</div>
				<table class="table tf-table" style="margin:0;font-size:11px;">
					<thead><tr>
						<th>Item</th><th>Qty</th><th>Order</th><th>Customer</th><th>Truck</th>
					</tr></thead>
					<tbody>
						${aps_entries.map(e => `<tr style="background:#fffbeb;">
							<td><strong>${frappe.utils.escape_html(e.item_name)}</strong></td>
							<td>${e.qty} ${frappe.utils.escape_html(e.uom)}</td>
							<td><a href="/app/sales-order/${e.order}" target="_blank" style="color:#667eea;">${frappe.utils.escape_html(e.order)}</a></td>
							<td>${frappe.utils.escape_html(e.customer)}</td>
							<td>${frappe.utils.escape_html(e.truck)}</td>
						</tr>`).join('')}
					</tbody>
				</table>
			</div>`;
		}

		// ── Per-truck order tables ────────────────────────────────────────────
		trucks.forEach(truck => {
			const tn = truck.truck_number;

			const order_rows = truck.orders.map(order => {
				const all_covered = order.items.every(i => {
					const alloc = (this.allocations[i.item_code] || {})[tn] || 0;
					return alloc >= i.required_qty;
				});
				const has_aps = (order.items || []).some(i =>
					(i.item_name || i.item_code || '').toUpperCase().includes('APS')
				);
				const region = order.delivery_region || '';

				const item_rows = (order.items || []).map(i => {
					const alloc = (this.allocations[i.item_code] || {})[tn] || 0;
					const short = Math.max(0, i.required_qty - alloc);
					const is_aps = (i.item_name || i.item_code || '').toUpperCase().includes('APS');
					return `<tr style="background:${is_aps ? '#fffbeb' : '#f8fafc'};">
						<td style="padding:3px 10px;font-size:11px;${is_aps ? 'font-weight:600;color:#92400e;' : 'color:#475569;'}">${frappe.utils.escape_html(i.item_name || i.item_code)}</td>
						<td style="padding:3px 10px;font-size:11px;text-align:right;">${i.required_qty} ${frappe.utils.escape_html(i.uom || '')}</td>
						<td style="padding:3px 10px;font-size:11px;text-align:right;color:${short > 0 ? '#ef4444' : '#10b981'};">${short > 0 ? '-' + short.toFixed(2) : '✓'}</td>
					</tr>`;
				}).join('');

				const row_id = `tf-cv-items-${order.name.replace(/[^a-z0-9]/gi, '_')}`;
				return `<tr class="tf-cv-order-row${has_aps ? ' tf-cv-aps-row' : ''}" style="${has_aps ? 'background:#fffbeb;' : ''}">
					<td style="width:28px;cursor:pointer;" class="tf-cv-toggle" data-target="${row_id}">
						<span class="tf-cv-arrow" style="display:inline-block;transition:transform .15s;">&#9658;</span>
					</td>
					<td><a href="/app/sales-order/${order.name}" target="_blank" style="color:#667eea;font-weight:600;">${frappe.utils.escape_html(order.name)}</a>${has_aps ? ' <span style="font-size:9px;background:#f59e0b;color:#fff;padding:1px 4px;border-radius:3px;vertical-align:middle;">APS</span>' : ''}</td>
					<td>${frappe.utils.escape_html(order.customer_name)}</td>
					<td>${region ? frappe.utils.escape_html(region) : '<span style="color:#cbd5e1;">—</span>'}</td>
					<td style="text-align:right;">${format_currency(order.grand_total, null, 0)}</td>
					<td style="text-align:center;">
						<span class="tf-status-badge" style="background:${all_covered ? '#10b981' : '#f59e0b'};font-size:10px;">
							${all_covered ? 'Covered' : 'Short'}
						</span>
					</td>
				</tr>
				<tr id="${row_id}" class="tf-cv-items-row" style="display:none;">
					<td colspan="6" style="padding:0 0 0 28px;background:#f8fafc;">
						<table style="width:100%;border-collapse:collapse;">
							<thead><tr>
								<th style="padding:3px 10px;font-size:10px;color:#94a3b8;font-weight:600;text-align:left;">Item</th>
								<th style="padding:3px 10px;font-size:10px;color:#94a3b8;font-weight:600;text-align:right;">Qty</th>
								<th style="padding:3px 10px;font-size:10px;color:#94a3b8;font-weight:600;text-align:right;">Short</th>
							</tr></thead>
							<tbody>${item_rows}</tbody>
						</table>
					</td>
				</tr>`;
			}).join('');

			html += `
			<div style="margin-bottom:20px;">
				<div style="font-size:12px;font-weight:700;color:#475569;padding:5px 0 6px;border-bottom:2px solid #e2e8f0;margin-bottom:8px;display:flex;gap:8px;align-items:center;">
					&#128666; ${frappe.utils.escape_html(tn)}
					<span style="font-weight:400;color:#94a3b8;">${truck.orders.length} customer${truck.orders.length !== 1 ? 's' : ''}</span>
				</div>
				<table class="table tf-table" style="margin:0;">
					<thead><tr>
						<th style="width:28px;"></th>
						<th>Order</th><th>Customer</th><th>Region</th>
						<th style="text-align:right;">Value</th><th style="text-align:center;">Status</th>
					</tr></thead>
					<tbody>${order_rows}</tbody>
				</table>
			</div>`;
		});

		return html;
	}

	// ── Item Summary Tab ──────────────────────────────────────────────────────

	_render_summary_tab() {
		const item_summary = this._compute_item_summary();
		let items = Object.values(item_summary).sort((a, b) => b.total_short - a.total_short);

		if (this.search_term) {
			const q = this.search_term.toLowerCase();
			items = items.filter(s =>
				(s.item_code || '').toLowerCase().includes(q) ||
				(s.item_name || '').toLowerCase().includes(q)
			);
		}

		const short_items = items.filter(s => s.total_short > 0);

		if (!items.length) {
			return `<div class="alert alert-info" style="margin-top:20px;">
				<strong>${this.search_term ? 'No items match your search.' : 'No items — assign orders to active trucks first.'}</strong>
			</div>`;
		}

		const display = short_items.length ? short_items : items;
		const showing_all = !short_items.length;

		let html = `
		<div style="display:flex;align-items:center;gap:14px;margin-bottom:14px;font-size:12px;color:#6b7280;">
			<span>${items.length} item${items.length !== 1 ? 's' : ''} across active trucks${short_items.length ? ` &nbsp;·&nbsp; <strong style="color:#ef4444;">${short_items.length} short</strong>` : ' &nbsp;·&nbsp; <strong style="color:#10b981;">all stocked</strong>'}</span>
			${short_items.length ? `<button class="btn btn-primary btn-xs btn-create-mr-summary" style="margin-left:auto;">Create MR for Shortages</button>` : ''}
		</div>
		<table class="table table-bordered tf-table">
			<thead><tr>
				<th>Item Code</th><th>Item Name</th>
				<th class="tf-r">Needed</th>
				<th class="tf-r">In Stock</th>
				<th class="tf-r">Short</th>
			</tr></thead><tbody>`;

		display.forEach(s => {
			const has_short = s.total_short > 0;
			html += `<tr>
				<td><strong>${frappe.utils.escape_html(s.item_code)}</strong></td>
				<td>${frappe.utils.escape_html(s.item_name)}</td>
				<td class="tf-r">${s.total_required.toFixed(2)} ${s.uom}</td>
				<td class="tf-r ${has_short ? 'tf-warn' : 'tf-ok'}">${s.in_stock.toFixed(2)}</td>
				<td class="tf-r ${has_short ? 'tf-short' : 'tf-ok'}">
					${has_short ? `<strong>${s.total_short.toFixed(2)}</strong>` : '—'}
				</td>
			</tr>`;
		});

		html += `</tbody></table>`;
		if (!showing_all && items.length > short_items.length) {
			html += `<p style="font-size:11px;color:#94a3b8;margin-top:6px;">Showing ${short_items.length} short item${short_items.length !== 1 ? 's' : ''}. ${items.length - short_items.length} item${items.length - short_items.length !== 1 ? 's' : ''} fully stocked.</p>`;
		}

		return html;
	}

	// ── Events ────────────────────────────────────────────────────────────────

	_attach_events() {
		const self = this;

		// Tab switching
		this.container.find('.tf-tab-btn').on('click', function () {
			const tab = $(this).data('tab');
			self.active_tab = tab;
			self.search_term = '';
			if (self.page.fields_dict.search_query) {
				self.page.fields_dict.search_query.set_value('');
			}
			self.container.find('.tf-tab-btn').removeClass('active');
			$(this).addClass('active');
			self.container.find('.tf-tab-pane').removeClass('active');
			self.container.find(`#tf-${tab}-pane`).addClass('active');
		});

		// Trucks sub-tab switching (Active / Dispatched)
		this.container.off('click.tf-stab').on('click.tf-stab', '.tf-subtab-btn', function () {
			self.trucks_subtab = $(this).data('subtab');
			self.container.find('#tf-trucks-pane').html(self._render_trucks_tab());
			self._attach_events();
		});

		// Allocation input
		this.container.off('input.tf-alloc').on('input.tf-alloc', '.tf-alloc-input', function () {
			const tn    = $(this).data('truck');
			const ic    = $(this).data('item');
			let   value = parseFloat($(this).val()) || 0;

			const max = parseFloat($(this).attr('max')) || 0;
			if (value > max) { value = max; $(this).val(max); }

			if (!self.allocations[ic]) self.allocations[ic] = {};
			self.allocations[ic][tn] = value;

			self._update_allocations_in_place(ic, tn);
			self._save_allocations();
		});

		// Customer view expandable order rows
		this.container.off('click.tf-cv-expand').on('click.tf-cv-expand', '.tf-cv-toggle', function () {
			const target_id = $(this).data('target');
			const $items_row = $(`#${target_id}`);
			const $arrow = $(this).find('.tf-cv-arrow');
			const is_open = $items_row.is(':visible');
			$items_row.slideToggle(150);
			$arrow.css('transform', is_open ? 'rotate(0deg)' : 'rotate(90deg)');
		});

		// Orders list toggle
		this.container.off('click.tf-toggle').on('click.tf-toggle', '.tf-orders-toggle', function () {
			const sid   = $(this).data('sid');
			const $list = $(`#tf-orders-list-${sid}`);
			const open  = $list.is(':visible');
			$list.slideToggle(150);
			$(this).text(open
				? `▸ Orders in this truck (${$list.children().length})`
				: `▾ Orders in this truck (${$list.children().length})`);
		});

		// Remove order from truck
		this.container.off('click.tf-remove').on('click.tf-remove', '.btn-remove-order', function () {
			self._remove_order_from_truck($(this).data('order'), $(this).data('truck'));
		});

		// Truck checkbox selection
		this.container.off('change.tf-chk').on('change.tf-chk', '.tf-truck-chk', function () {
			const tn = $(this).data('truck');
			$(this).is(':checked') ? self.selected_trucks.add(tn) : self.selected_trucks.delete(tn);
		});

		// Refresh stock button (Stock Overview tab)
		this.container.off('click.tf-rsb').on('click.tf-rsb', '.tf-refresh-stock-btn', function () {
			self._silent_refresh_stock();
		});

		// Per-truck MR button
		this.container.off('click.tf-tmr').on('click.tf-tmr', '.tf-truck-mr-btn', function () {
			self._create_mr_for_trucks([$(this).data('truck')]);
		});

		// Selected trucks MR
		this.container.off('click.tf-smr').on('click.tf-smr', '.tf-mr-selected-btn', function () {
			const selected = Array.from(self.selected_trucks);
			if (!selected.length) { frappe.msgprint(__('Tick at least one truck checkbox first.')); return; }
			self._create_mr_for_trucks(selected);
		});

		// New orders MR
		this.container.off('click.tf-nmr').on('click.tf-nmr', '.tf-mr-new-btn', function () {
			self._create_mr_for_new_items();
		});

		// Mark all as reviewed
		this.container.off('click.tf-rev').on('click.tf-rev', '.tf-mark-reviewed-btn', function () {
			self._save_snapshot();
			frappe.show_alert({ message: __('All orders marked as reviewed — new badges cleared'), indicator: 'green' });
			self.container.find('#tf-trucks-pane').html(self._render_trucks_tab());
			self._attach_events();
		});

		// Close (mark done) / Reopen truck
		this.container.off('click.tf-close').on('click.tf-close', '.tf-truck-close-btn', function () {
			const tn = $(this).data('truck');
			self._closed_trucks.add(tn);
			self._save_closed_trucks();
			self.container.find('#tf-trucks-pane').html(self._render_trucks_tab());
			self._attach_events();
			frappe.show_alert({ message: __('Truck {0} marked as complete', [tn]), indicator: 'green' });
		});
		this.container.off('click.tf-reopen').on('click.tf-reopen', '.tf-truck-reopen-btn', function () {
			const tn = $(this).data('truck');
			self._closed_trucks.delete(tn);
			self._save_closed_trucks();
			self.container.find('#tf-trucks-pane').html(self._render_trucks_tab());
			self._attach_events();
			frappe.show_alert({ message: __('Truck {0} reopened'), indicator: 'blue' });
		});


		// Pre-fulfilment region Done / Reopen
		this.container.off('click.tf-rclose').on('click.tf-rclose', '.tf-region-close-btn', function () {
			const tn = $(this).data('truck');
			self._closed_trucks.add(tn);
			self._save_closed_trucks();
			self.container.find('#tf-trucks-pane').html(self._render_trucks_tab());
			self._attach_events();
			frappe.show_alert({ message: __('Pre-fulfilment region marked as complete'), indicator: 'green' });
		});
		this.container.off('click.tf-rreopen').on('click.tf-rreopen', '.tf-region-reopen-btn', function () {
			const tn = $(this).data('truck');
			self._closed_trucks.delete(tn);
			self._save_closed_trucks();
			self.container.find('#tf-trucks-pane').html(self._render_trucks_tab());
			self._attach_events();
			frappe.show_alert({ message: __('Pre-fulfilment region reopened'), indicator: 'blue' });
		});

		// Summary tab: create MR button
		this.container.off('click.tf-mr').on('click.tf-mr', '.btn-create-mr-summary', () => {
			this._create_mr_from_summary();
		});

		// Customer view — print and download
		this.container.off('click.tf-cv-print').on('click.tf-cv-print', '.tf-cv-print-btn', () => {
			this._print_customers_tab();
		});
		this.container.off('click.tf-cv-dl').on('click.tf-cv-dl', '.tf-cv-dl-btn', () => {
			this._download_customers_tab();
		});
	}

	// ── In-place DOM update after allocation change ───────────────────────────

	_update_allocations_in_place(changed_ic, changed_tn) {
		const item_summary = this._compute_item_summary();

		Object.keys(item_summary).forEach(ic => {
			const s   = item_summary[ic];
			const sid = this._sid(ic);
			$(`#tf-ov-alloc-${sid}`).text(s.total_allocated.toFixed(2));
			$(`#tf-ov-rem-${sid}`).text(s.remaining_stock.toFixed(2));
			const $short = $(`#tf-ov-short-${sid}`);
			$short.removeClass('tf-short tf-ok').addClass(s.total_short > 0 ? 'tf-short' : 'tf-ok');
			$short.html(s.total_short > 0 ? `<strong>${s.total_short.toFixed(2)}</strong>` : '—');
		});

		this.truck_data.trucks.forEach(truck => {
			const tn  = truck.truck_number;
			const sid = this._sid(tn);

			truck.items.forEach(item => {
				const ic    = item.item_code;
				const alloc = (this.allocations[ic] || {})[tn] || 0;
				const avail = this._get_available_for_truck(ic, tn);
				const max   = Math.min(item.required_qty, alloc + avail);
				const short = Math.max(0, item.required_qty - alloc);

				this.container.find(
					`.tf-alloc-input[data-truck="${tn}"][data-item="${ic}"]`
				).attr('max', max.toFixed(3));

				const isid  = this._sid(ic);
				const $cell = $(`#tf-short-${sid}-${isid}`);
				$cell.removeClass('tf-short tf-ok').addClass(short > 0 ? 'tf-short' : 'tf-ok');
				$cell.html(short > 0 ? `<strong>${short.toFixed(2)}</strong>` : '—');
			});

			const truck_has_short = truck.items.some(item => {
				const alloc = (this.allocations[item.item_code] || {})[tn] || 0;
				return item.required_qty > alloc;
			});
			const label = truck.items.length === 0 ? 'No Items'
				: truck_has_short ? 'Has Shortages' : 'Fully Allocated';
			const color = truck.items.length === 0 ? '#9ca3af'
				: truck_has_short ? '#ef4444' : '#10b981';
			$(`#tf-status-${sid}`)
				.text(label)
				.css('background', color);
		});
	}

	// ── Actions ───────────────────────────────────────────────────────────────

	_remove_order_from_truck(order_name, truck_number) {
		frappe.confirm(
			__('Remove {0} from truck {1}? The order stays at Pending Confirmation — you can re-assign it later.', [order_name, truck_number]),
			() => {
				frappe.call({
					method: 'frappe.client.set_value',
					args: { doctype: 'Sales Order', name: order_name, fieldname: 'custom_truck_number', value: '' },
					callback: () => {
						frappe.show_alert({ message: __('Order removed from truck — truck weights recalculated'), indicator: 'orange' });
						this.load_data();
					},
				});
			}
		);
	}

	auto_allocate() {
		if (!this.truck_data.trucks.length) {
			frappe.msgprint(__('No trucks to allocate.'));
			return;
		}

		this.allocations = {};

		const trucks  = this.truck_data.trucks;
		const stock   = this.truck_data.stock;

		const all_items = new Set();
		trucks.forEach(t => t.items.forEach(i => all_items.add(i.item_code)));

		all_items.forEach(ic => {
			let remaining = (stock[ic] || {}).available_qty || 0;
			this.allocations[ic] = {};

			trucks.forEach(truck => {
				if (remaining <= 0) {
					this.allocations[ic][truck.truck_number] = 0;
					return;
				}
				const needed = (truck.items.find(i => i.item_code === ic) || {}).required_qty || 0;
				const give   = Math.min(needed, remaining);
				this.allocations[ic][truck.truck_number] = give;
				remaining -= give;
			});
		});

		this._save_allocations();
		this.container.find('#tf-trucks-pane').html(this._render_trucks_tab());
		this._attach_events();
		frappe.show_alert({ message: __('Stock auto-allocated to trucks'), indicator: 'green' });
	}

	create_requisition() {
		if (!this.truck_data.trucks.length) {
			frappe.msgprint(__('No truck data loaded.'));
			return;
		}

		const item_summary = this._compute_item_summary();
		const shortage_items = Object.values(item_summary)
			.filter(s => s.total_short > 0)
			.map(s => ({
				item_code:    s.item_code,
				item_name:    s.item_name,
				shortage_qty: s.total_short,
				uom:          s.uom,
			}));

		if (!shortage_items.length) {
			frappe.msgprint({ title: __('No Shortages'), message: __('All items have sufficient stock.'), indicator: 'green' });
			return;
		}

		frappe.confirm(
			__('Create a Material Request for {0} item(s) with shortages?', [shortage_items.length]),
			() => frappe.call({
				method: 'crystal_custom.crystal_customizations.page.item_order_fulfillme.item_order_fulfillme.create_requisition_from_shortage_items',
				args: { shortage_items: JSON.stringify(shortage_items) },
				freeze: true,
				freeze_message: __('Creating Material Request…'),
				callback: (r) => {
					if (r.message) {
						this._save_snapshot();
						frappe.set_route('Form', 'Material Request', r.message);
					}
				},
			})
		);
	}

	_create_mr_from_summary() {
		const from_date = this.page.fields_dict.from_date.get_value();
		const to_date   = this.page.fields_dict.to_date.get_value();
		frappe.confirm(
			__('Create a Material Request for all shortages in this date range?'),
			() => frappe.call({
				method: 'crystal_custom.crystal_customizations.page.item_order_fulfillme.item_order_fulfillme.create_material_request_from_shortage',
				args: { from_date, to_date },
				freeze: true,
				freeze_message: __('Creating Material Request…'),
				callback: (r) => {
					if (r.message) frappe.set_route('Form', 'Material Request', r.message);
				},
				error: () => frappe.msgprint({ title: __('Error'), message: __('No shortages found'), indicator: 'red' }),
			})
		);
	}

	// ── Snapshot (new-order tracking via localStorage) ────────────────────────

	_load_closed_trucks() {
		try { return new Set(JSON.parse(localStorage.getItem('crystal_tf_closed_trucks') || '[]')); }
		catch(e) { return new Set(); }
	}

	_save_closed_trucks() {
		const json = JSON.stringify([...this._closed_trucks]);
		localStorage.setItem('crystal_tf_closed_trucks', json);
		frappe.call({
			method: 'crystal_custom.crystal_customizations.page.item_order_fulfillme.item_order_fulfillme.save_ofm_closed_trucks',
			args: { trucks_json: json },
		});
	}


	_load_snapshot() {
		try { return JSON.parse(localStorage.getItem('crystal_truck_snapshot') || 'null') || {}; }
		catch(e) { return {}; }
	}

	_has_snapshot() {
		return localStorage.getItem('crystal_truck_snapshot') !== null;
	}

	_save_snapshot() {
		const snap = {};
		this.truck_data.trucks.filter(t => !t.is_region_bucket).forEach(t => {
			snap[t.truck_number] = (t.orders || []).map(o => o.name);
		});
		localStorage.setItem('crystal_truck_snapshot', JSON.stringify(snap));
		this.truck_snapshot = snap;
	}

	_is_order_new(truck_number, order_name) {
		if (!this._has_snapshot()) return false;
		const snap = this.truck_snapshot[truck_number];
		if (snap === undefined) return true; // new truck since last review
		return !snap.includes(order_name);
	}

	_count_new_orders() {
		let n = 0;
		this.truck_data.trucks.filter(t => !t.is_region_bucket).forEach(t => {
			(t.orders || []).forEach(o => { if (this._is_order_new(t.truck_number, o.name)) n++; });
		});
		return n;
	}

	// ── Per-truck / selective MR creation ────────────────────────────────────

	_create_mr_for_trucks(truck_numbers) {
		const set = new Set(truck_numbers);
		const item_totals = {};
		this.truck_data.trucks.filter(t => set.has(t.truck_number)).forEach(truck => {
			truck.items.forEach(item => {
				// Use stock available to this truck (total stock minus what others are allocated).
				// If nothing is allocated to anyone, this equals total stock — giving a true
				// shortage based on what's actually needed vs what's in the warehouse.
				const avail = truck.is_region_bucket
					? (this.truck_data.stock[item.item_code] || {}).available_qty || 0
					: this._get_available_for_truck(item.item_code, truck.truck_number);
				const short = Math.max(0, item.required_qty - avail);
				if (short <= 0) return;
				if (!item_totals[item.item_code]) {
					item_totals[item.item_code] = { item_code: item.item_code, item_name: item.item_name, shortage_qty: 0, uom: item.uom };
				}
				item_totals[item.item_code].shortage_qty += short;
			});
		});
		const shortage_items = Object.values(item_totals);
		if (!shortage_items.length) {
			frappe.msgprint(__('No shortages in the selected truck(s).'));
			return;
		}
		frappe.confirm(
			__('Create Material Request for {0} item(s) across {1} selected truck(s)?', [shortage_items.length, truck_numbers.length]),
			() => frappe.call({
				method: 'crystal_custom.crystal_customizations.page.item_order_fulfillme.item_order_fulfillme.create_requisition_from_shortage_items',
				args: { shortage_items: JSON.stringify(shortage_items) },
				freeze: true, freeze_message: __('Creating Material Request…'),
				callback: (r) => {
					if (r.message) frappe.set_route('Form', 'Material Request', r.message);
				},
			})
		);
	}

	_create_mr_for_new_items() {
		const item_totals = {};
		this.customer_data.trucks.forEach(truck => {
			const tn = truck.truck_number;
			(truck.orders || []).forEach(order => {
				if (!this._is_order_new(tn, order.name)) return;
				(order.items || []).forEach(item => {
					if (item.required_qty <= 0) return;
					if (!item_totals[item.item_code]) {
						item_totals[item.item_code] = {
							item_code:   item.item_code,
							item_name:   item.item_name,
							shortage_qty: 0,
							uom:         item.uom,
						};
					}
					item_totals[item.item_code].shortage_qty += item.required_qty;
				});
			});
		});

		if (!Object.keys(item_totals).length) {
			frappe.msgprint(__('No items found in new orders — click "Mark All as Reviewed" first if this is unexpected.'));
			return;
		}

		// Check existing pending MRs so we don't re-request what's already covered
		frappe.call({
			method: 'crystal_custom.crystal_customizations.page.item_order_fulfillme.item_order_fulfillme.get_pending_mr_quantities',
			args: { item_codes_json: JSON.stringify(Object.keys(item_totals)) },
			callback: (r) => {
				const pending = r.message || {};

				// Net qty = new-order requirement minus what's already pending in open MRs
				Object.values(item_totals).forEach(item => {
					const in_mr = pending[item.item_code] || 0;
					item.already_in_mr = in_mr;
					item.shortage_qty  = Math.max(0, item.shortage_qty - in_mr);
				});

				const shortage_items = Object.values(item_totals).filter(i => i.shortage_qty > 0);
				const skipped_count  = Object.values(item_totals).filter(i => i.shortage_qty <= 0 && i.already_in_mr > 0).length;

				if (!shortage_items.length) {
					frappe.msgprint({
						title:   __('Already Covered'),
						message: __('All items from the new orders are already covered by existing pending Material Requests.'),
						indicator: 'green',
					});
					return;
				}

				const skip_note = skipped_count
					? `\n(${skipped_count} item${skipped_count !== 1 ? 's' : ''} skipped — already in a pending MR)`
					: '';

				frappe.confirm(
					__('Create Material Request for {0} item(s) from newly added orders?', [shortage_items.length]) + skip_note,
					() => frappe.call({
						method: 'crystal_custom.crystal_customizations.page.item_order_fulfillme.item_order_fulfillme.create_requisition_from_shortage_items',
						args: { shortage_items: JSON.stringify(shortage_items) },
						freeze: true, freeze_message: __('Creating Material Request…'),
						callback: (r) => {
							if (r.message) {
								this._save_snapshot();
								frappe.set_route('Form', 'Material Request', r.message);
							}
						},
					})
				);
			},
		});
	}

	// ── Helpers ───────────────────────────────────────────────────────────────

	_sid(str) {
		return String(str).replace(/[^a-zA-Z0-9]/g, '_');
	}

	_kpi(label, value, color) {
		return `<div class="tf-kpi" style="border-top:4px solid ${color}">
			<div class="tf-kpi-label">${label}</div>
			<div class="tf-kpi-value" style="color:${color}">${value}</div>
		</div>`;
	}

	_loading_html() {
		return `<div style="text-align:center;padding:60px;color:#9ca3af;">
			<i class="fa fa-spinner fa-spin fa-2x"></i><br><br>Loading…
		</div>`;
	}

	// ── Styles ────────────────────────────────────────────────────────────────

	_styles() {
		return `<style>
		.tf-container { margin-top: 16px; }

		/* Tabs */
		.tf-tabs {
			display: flex;
			border-bottom: 2px solid #667eea;
			gap: 4px;
			margin-bottom: 20px;
		}
		.tf-tab-btn {
			background: none;
			border: none;
			border-bottom: 3px solid transparent;
			margin-bottom: -2px;
			padding: 10px 20px;
			font-weight: 600;
			font-size: 14px;
			color: #6b7280;
			cursor: pointer;
			display: flex;
			align-items: center;
			gap: 6px;
			outline: none;
			transition: color .2s;
		}
		.tf-tab-btn:hover { color: #667eea; }
		.tf-tab-btn.active { color: #667eea; border-bottom-color: #667eea; }
		.tf-tab-badge {
			background: #667eea;
			color: #fff;
			border-radius: 10px;
			padding: 1px 7px;
			font-size: 11px;
			font-weight: 700;
		}
		.tf-tab-pane { display: none; }
		.tf-tab-pane.active { display: block; }

		/* KPI */
		.tf-kpi-row {
			display: grid;
			grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
			gap: 12px;
			margin-bottom: 20px;
		}
		.tf-kpi {
			background: #fff;
			border-radius: 8px;
			padding: 14px 18px;
			box-shadow: 0 1px 4px rgba(0,0,0,.06);
		}
		.tf-kpi-label { font-size: 11px; color: #6b7280; font-weight: 600; text-transform: uppercase; letter-spacing: .5px; }
		.tf-kpi-value { font-size: 20px; font-weight: 700; margin-top: 4px; }

		/* Section */
		.tf-section {
			background: #fff;
			border-radius: 8px;
			padding: 16px;
			box-shadow: 0 1px 4px rgba(0,0,0,.06);
			margin-bottom: 20px;
			overflow-x: auto;
		}
		.tf-section-header {
			font-size: 14px;
			font-weight: 700;
			color: #1e293b;
			margin-bottom: 14px;
			padding-bottom: 10px;
			border-bottom: 2px solid #f1f5f9;
			display: flex;
			align-items: center;
			justify-content: space-between;
		}
		.tf-header-note { font-size: 12px; font-weight: 400; color: #94a3b8; }

		/* Tables */
		.tf-table thead th {
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
		.tf-table td { padding: 9px 10px !important; vertical-align: middle !important; font-size: 13px; }
		.tf-table tr:hover td { background: #f8fafc; }
		.tf-r   { text-align: right !important; }
		.tf-ok   { color: #059669; font-weight: 600; }
		.tf-warn { color: #d97706; font-weight: 600; }
		.tf-short { color: #dc2626; }
		.tf-empty { color: #9ca3af; font-style: italic; padding: 16px; text-align: center; }

		/* Status badge */
		.tf-status-badge {
			display: inline-block;
			padding: 3px 10px;
			border-radius: 4px;
			font-size: 11px;
			font-weight: 600;
			color: #fff;
			white-space: nowrap;
		}

		/* Allocation input */
		.tf-alloc-input {
			width: 90px;
			height: 26px;
			padding: 2px 6px;
			font-size: 12px;
			text-align: right;
			border: 1px solid #cbd5e1;
			border-radius: 4px;
			background: #f0fdf4;
			transition: border-color .15s, box-shadow .15s;
		}
		.tf-alloc-input:focus {
			outline: none;
			border-color: #10b981;
			box-shadow: 0 0 0 2px rgba(16,185,129,.15);
			background: #fff;
		}

		/* Truck grid */
		.tf-trucks-grid {
			display: grid;
			grid-template-columns: repeat(auto-fill, minmax(420px, 1fr));
			gap: 16px;
		}
		.tf-truck-card {
			border: 1px solid #e2e8f0;
			border-radius: 8px;
			overflow: hidden;
			background: #fff;
			box-shadow: 0 1px 4px rgba(0,0,0,.05);
		}
		.tf-truck-head {
			display: flex;
			justify-content: space-between;
			align-items: center;
			padding: 12px 14px;
			background: #1e293b;
		}
		.tf-truck-num  { font-size: 15px; font-weight: 700; color: #f1f5f9; }
		.tf-truck-meta { font-size: 12px; color: #94a3b8; margin-top: 2px; }
		.tf-truck-region-tag { font-size: 11px; background: rgba(255,255,255,0.15); color: #e2e8f0; border-radius: 10px; padding: 2px 8px; margin-left: 6px; vertical-align: middle; }
		.tf-card-table {
			width: 100%;
			border-collapse: collapse;
			font-size: 12px;
		}
		.tf-card-table thead th {
			background: #f1f5f9;
			color: #475569;
			font-size: 11px;
			font-weight: 700;
			text-transform: uppercase;
			padding: 7px 10px;
			border-bottom: 1px solid #e2e8f0;
			white-space: nowrap;
		}
		.tf-card-table td {
			padding: 8px 10px;
			border-bottom: 1px solid #f1f5f9;
			vertical-align: middle;
		}
		.tf-card-table tr:last-child td { border-bottom: none; }
		.tf-card-table tr:hover td { background: #f8fafc; }
		.tf-item-name { color: #64748b; max-width: 160px; }
		.tf-short-cell { font-family: monospace; }
		.tf-affected-custs { font-family: sans-serif; font-size: 10px; font-weight: 400; color: #dc2626; opacity: 0.85; margin-top: 2px; white-space: normal; line-height: 1.3; }

		/* Orders in truck */
		.tf-orders-section { border-top: 1px solid #f1f5f9; }
		.tf-orders-toggle {
			padding: 8px 14px;
			font-size: 12px;
			font-weight: 600;
			color: #475569;
			cursor: pointer;
			background: #f8fafc;
			user-select: none;
		}
		.tf-orders-toggle:hover { background: #f1f5f9; }
		.tf-orders-list { border-top: 1px solid #f1f5f9; }
		.tf-order-row {
			display: flex;
			justify-content: space-between;
			align-items: center;
			padding: 7px 14px;
			border-bottom: 1px solid #f1f5f9;
			font-size: 12px;
		}
		.tf-order-row:last-child { border-bottom: none; }
		.tf-order-link { font-weight: 600; color: #3b82f6; text-decoration: none; }
		.tf-order-link:hover { text-decoration: underline; }
		.tf-order-cust { display: block; color: #94a3b8; font-size: 11px; margin-top: 1px; }

		/* Paint / Colour Notes */
		.tf-order-row-paint { background: #fffbeb; border-left: 3px solid #f59e0b; padding-left: 9px !important; }
		.tf-paint-warn-badge { display: inline-block; font-size: 10px; font-weight: 700;
			background: #fef3c7; color: #92400e; border: 1px solid #fcd34d;
			border-radius: 10px; padding: 1px 7px; margin-left: 6px; }
		.tf-paint-notes-banner { margin-top: 5px; padding: 5px 10px; background: #fef3c7;
			border: 1px solid #fcd34d; border-radius: 4px; font-size: 12px; color: #78350f; }
		.cv-paint-alert { background: #fef3c7; border-bottom: 1px solid #fcd34d;
			padding: 8px 14px; font-size: 13px; color: #78350f; font-weight: 600; }
		.cv-cust-block-paint { border-color: #f59e0b !important; border-width: 2px !important; }

		/* New-order highlighting */
		.tf-order-row-new { background: #f0fdf4 !important; border-left: 3px solid #10b981; padding-left: 9px !important; }
		.tf-new-badge {
			display: inline-block; padding: 1px 6px; background: #10b981; color: #fff;
			border-radius: 8px; font-size: 10px; font-weight: 700; vertical-align: middle;
			margin-left: 5px; letter-spacing: .3px;
		}
		.tf-truck-actions {
			display: flex; flex-wrap: wrap; gap: 8px; align-items: center;
			margin-bottom: 14px; padding: 10px 14px;
			background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 6px;
		}
		.tf-new-notice { font-size: 12px; color: #10b981; font-weight: 600; margin-left: 6px; }

		/* Active / Dispatched sub-tabs */
		.tf-subtabs {
			display: flex;
			gap: 4px;
			border-bottom: 2px solid #e2e8f0;
			margin-bottom: 20px;
		}
		.tf-subtab-btn {
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
		.tf-subtab-btn:hover { color: #8b5cf6; }
		.tf-subtab-btn.active { color: #8b5cf6; border-bottom-color: #8b5cf6; }
		.tf-subtab-badge {
			background: #8b5cf6;
			color: #fff;
			border-radius: 10px;
			padding: 1px 7px;
			font-size: 11px;
			font-weight: 700;
		}

		/* Refined workspace shell */
		.tf-container {
			--tf-primary: #4f46e5;
			--tf-primary-soft: #eef2ff;
			--tf-ink: #172033;
			--tf-muted: #667085;
			--tf-border: #e4e7ec;
			margin-bottom: 40px;
			color: var(--tf-ink);
		}
		.tf-page-intro {
			display: flex;
			align-items: flex-end;
			justify-content: space-between;
			gap: 24px;
			padding: 22px 24px;
			margin-bottom: 16px;
			border: 1px solid var(--tf-border);
			border-radius: 14px;
			background:
				radial-gradient(circle at 92% 10%, rgba(99,102,241,.13), transparent 30%),
				linear-gradient(135deg, #fff 0%, #f8faff 100%);
			box-shadow: 0 1px 2px rgba(16,24,40,.04);
		}
		.tf-page-intro h2 { margin: 2px 0 5px; font-size: 22px; line-height: 1.25; color: var(--tf-ink); }
		.tf-page-intro p { margin: 0; color: var(--tf-muted); font-size: 13px; }
		.tf-eyebrow { color: var(--tf-primary); font-size: 11px; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; }
		.tf-live-status {
			display: flex; align-items: center; gap: 7px; flex-shrink: 0;
			padding: 7px 11px; border: 1px solid #d1fae5; border-radius: 999px;
			background: #f0fdf4; color: #047857; font-size: 11px; font-weight: 600;
		}
		.tf-live-dot { width: 7px; height: 7px; border-radius: 50%; background: #10b981; box-shadow: 0 0 0 3px rgba(16,185,129,.14); }

		.tf-tabs {
			gap: 6px; padding: 5px; border: 1px solid var(--tf-border);
			border-radius: 12px; background: #f8fafc; overflow-x: auto;
		}
		.tf-tab-btn {
			margin-bottom: 0; padding: 9px 15px; border: 1px solid transparent;
			border-radius: 8px; border-bottom-width: 1px; white-space: nowrap;
			transition: background .15s, color .15s, box-shadow .15s;
		}
		.tf-tab-btn:hover { color: var(--tf-primary); background: var(--tf-primary-soft); }
		.tf-tab-btn.active {
			color: var(--tf-primary); background: #fff; border-color: var(--tf-border);
			box-shadow: 0 1px 3px rgba(16,24,40,.08);
		}
		.tf-tab-icon { font-size: 14px; opacity: .8; }
		.tf-tab-badge { background: var(--tf-primary-soft); color: var(--tf-primary); }
		.tf-tab-btn.active .tf-tab-badge { background: var(--tf-primary); color: #fff; }

		.tf-kpi, .tf-section {
			border: 1px solid var(--tf-border); border-radius: 12px;
			box-shadow: 0 1px 2px rgba(16,24,40,.04);
		}
		.tf-table { border: 1px solid var(--tf-border); border-radius: 10px; overflow: hidden; }
		.tf-table thead th {
			background: #f8fafc; color: #475467;
			border-bottom: 1px solid var(--tf-border) !important;
		}
		.tf-table td { border-color: #eef0f3 !important; }
		.tf-status-badge { border-radius: 999px; }
		.tf-trucks-grid { gap: 18px; }
		.tf-truck-card {
			border-color: var(--tf-border); border-radius: 12px;
			box-shadow: 0 2px 5px rgba(16,24,40,.05);
			transition: transform .15s ease, box-shadow .15s ease;
		}
		.tf-truck-card:hover { transform: translateY(-1px); box-shadow: 0 7px 16px rgba(16,24,40,.08); }
		.tf-truck-head { padding: 14px 16px; background: linear-gradient(135deg, #263248, #172033); gap: 12px; }
		.tf-truck-actions { border-color: var(--tf-border); border-radius: 10px; }
		.tf-subtabs { gap: 8px; border-bottom: 0; }
		.tf-subtab-btn {
			margin-bottom: 0; padding: 7px 14px; border: 1px solid var(--tf-border);
			border-radius: 999px; border-bottom-width: 1px; background: #fff;
		}
		.tf-subtab-btn.active { color: #6d28d9; border-color: #c4b5fd; background: #f5f3ff; }

		@media (max-width: 767px) {
			.tf-container { margin-top: 10px; }
			.tf-page-intro { align-items: flex-start; padding: 17px; }
			.tf-page-intro h2 { font-size: 18px; }
			.tf-page-intro p { max-width: 300px; }
			.tf-live-status { display: none; }
			.tf-tabs { margin-left: -5px; margin-right: -5px; border-radius: 8px; }
			.tf-tab-btn { padding: 8px 11px; }
			.tf-trucks-grid { grid-template-columns: minmax(0, 1fr); gap: 12px; }
			.tf-truck-head { align-items: flex-start; flex-direction: column; }
			.tf-truck-head > div:last-child { width: 100%; flex-wrap: wrap; }
			.tf-section { padding: 12px; }
			.tf-header-note { display: none; }
			.tf-card-table { min-width: 560px; }
			.tf-truck-card { overflow-x: auto; }
			.tf-kpi-row { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; }
		}
		</style>`;
	}
}



