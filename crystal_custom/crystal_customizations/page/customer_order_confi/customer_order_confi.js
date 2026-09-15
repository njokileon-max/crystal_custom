frappe.pages['customer-order-confi'].on_page_load = function(wrapper) {
	var page = frappe.ui.make_app_page({
		parent: wrapper,
		title: 'Customer Order Confirmation',
		single_column: true
	});
	new OrderConfirmationManager(page);
}

class OrderConfirmationManager {
    constructor(page) {
        this.page = page;
        this.filters = {};
        this.orders = [];
        this.submitted_orders = [];
        this.called_orders = new Set();
        this.not_picked_orders = new Set();
        this.declined_orders = new Set();
        this._editor_items = {};
        this.current_page = 1;
        this.page_size = 50;
        this._sps = new Set();
        this.setup_page();
        this.load_data();
    }

    setup_page() {
        this.page.add_field({
            label: 'Customer',
            fieldtype: 'Link',
            fieldname: 'customer',
            options: 'Customer',
            change: () => this.apply_filters()
        });

        this.page.add_field({
            label: 'Delivery Region',
            fieldtype: 'Link',
            fieldname: 'delivery_region',
            options: 'Delivery Region',
            change: () => this.apply_filters()
        });

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
                this.current_page = 1; this.load_data();
            }
        });
        this._sp_pills_wrap = $('<div class="sp-pills-wrap"></div>').appendTo(this.page.page_form);

        this.page.add_field({
            label: 'From Date',
            fieldtype: 'Date',
            fieldname: 'from_date',
            change: () => { this.current_page = 1; this.load_data(); }
        });

        this.page.add_field({
            label: 'To Date',
            fieldtype: 'Date',
            fieldname: 'to_date',
            change: () => { this.current_page = 1; this.load_data(); }
        });

        this.page.add_field({
            label: 'Status',
            fieldtype: 'Select',
            fieldname: 'status_filter',
            options: '\nAll\nPending Call\nCalled\nNot Picked\nDeclined',
            default: 'All',
            change: () => this.apply_filters()
        });

        this.page.set_primary_action('Submit Called Orders', () => {
            this.submit_orders(Array.from(this.called_orders), 'called');
        }, 'octicon octicon-check');

        this.page.add_button('Submit Not Picked Orders', () => {
            this.submit_orders(Array.from(this.not_picked_orders), 'not picked');
        }, 'octicon octicon-arrow-right');

        this.page.add_button('Refresh', () => {
            this.load_data();
        }, 'octicon octicon-sync');

        this.container = $('<div class="order-confirmation-container"></div>').appendTo(this.page.main);
    }

    load_data() {
        const from_date = this.page.fields_dict.from_date.get_value();
        const to_date = this.page.fields_dict.to_date.get_value();
        const sps = [...this._sps];

        frappe.call({
            method: 'crystal_custom.crystal_customizations.page.sales_order_truck_as.sales_order_truck_as.get_truck_assignment_orders',
            args: {
                from_date: from_date || null,
                to_date: to_date || null,
                sales_persons_json: sps.length ? JSON.stringify(sps) : null,
            },
            callback: (r) => {
                if (!r.message) return;
                const all = [...(r.message.assigned || []), ...(r.message.unassigned || [])];
                const seen = new Set();
                const orders = all.filter(o => { if (seen.has(o.name)) return false; seen.add(o.name); return true; });

                this.orders = orders.filter(o => parseInt(o.docstatus) === 0);
                this.submitted_orders = orders.filter(o => parseInt(o.docstatus) === 1);

                this.orders.forEach(order => {
                    if (order.custom_call_not_picked === 1) {
                        this.not_picked_orders.add(order.name);
                    }
                });
                this._attach_customer_phones();
            }
        });
    }

    load_submitted_orders() {
        // Loading is now handled inside load_data(); this stub kept for any direct callers.
        this._attach_customer_phones();
    }

    _attach_customer_phones() {
        const all_orders = [...this.orders, ...this.submitted_orders];
        const customers  = [...new Set(all_orders.map(o => o.customer).filter(Boolean))];
        if (!customers.length) { this.render_orders(); return; }

        frappe.call({
            method: 'frappe.client.get_list',
            args: {
                doctype: 'Customer',
                fields: ['name', 'custom_phone_number'],
                filters: [['Customer', 'name', 'in', customers]],
                limit_page_length: customers.length,
            },
            callback: (r) => {
                const phone_map = {};
                (r.message || []).forEach(c => { phone_map[c.name] = c.custom_phone_number; });
                all_orders.forEach(o => {
                    if (!o.custom_phone_number) o.custom_phone_number = phone_map[o.customer] || '';
                });
                this.render_orders();
            },
            error: () => this.render_orders(),
        });
    }

    apply_filters() {
        this.filters = {
            customer: this.page.fields_dict.customer.get_value(),
            delivery_region: this.page.fields_dict.delivery_region.get_value(),
            status: this.page.fields_dict.status_filter.get_value()
        };
        this.current_page = 1;
        this.render_orders();
    }

    get_filtered_orders() {
        return this.orders.filter(order => {
            if (this.filters.customer && order.customer !== this.filters.customer) {
                return false;
            }
            if (this.filters.delivery_region && order.custom_delivery_region !== this.filters.delivery_region) {
                return false;
            }
            if (this.filters.status && this.filters.status !== 'All') {
                const is_called     = this.called_orders.has(order.name);
                const is_not_picked = this.not_picked_orders.has(order.name);
                const is_declined   = this.declined_orders.has(order.name);

                if (this.filters.status === 'Pending Call'  && (is_called || is_not_picked || is_declined)) return false;
                if (this.filters.status === 'Called'        && !is_called)     return false;
                if (this.filters.status === 'Not Picked'    && !is_not_picked) return false;
                if (this.filters.status === 'Declined'      && !is_declined)   return false;
            }
            return true;
        });
    }

    render_orders() {
        const all_filtered = this.get_filtered_orders();

        // Sort by truck so same-truck orders stay together across pages
        const sorted_all = [...all_filtered].sort((a, b) => {
            const ta = a.custom_truck_number || '';
            const tb = b.custom_truck_number || '';
            if (!ta && !tb) return 0;
            if (!ta) return 1;
            if (!tb) return -1;
            return ta.localeCompare(tb);
        });

        const total_pages = Math.ceil(sorted_all.length / this.page_size) || 1;
        if (this.current_page > total_pages) this.current_page = total_pages;
        const filtered_orders = sorted_all.slice(
            (this.current_page - 1) * this.page_size,
            this.current_page * this.page_size
        );

        if (all_filtered.length === 0) {
            this.container.html(`
                <div class="alert alert-info" style="margin-top: 20px;">
                    <strong>No orders found</strong><br>
                    ${this.orders.length > 0 ? 
                        'No orders match your filters. Try adjusting or clearing the filters.' : 
                        'No sales orders pending customer reconfirmation.'}
                </div>
            `);
            return;
        }

        const total_value = all_filtered.reduce((sum, o) => sum + o.grand_total, 0);
        const called_count     = all_filtered.filter(o => this.called_orders.has(o.name)).length;
        const not_picked_count = all_filtered.filter(o => this.not_picked_orders.has(o.name)).length;
        const declined_count   = all_filtered.filter(o => this.declined_orders.has(o.name)).length;
        const pending_count    = all_filtered.filter(o =>
            !this.called_orders.has(o.name) && !this.not_picked_orders.has(o.name) && !this.declined_orders.has(o.name)
        ).length;
        
        let html = `
            <div class="confirmation-orders-table">
                <div class="summary-card">
                    <div class="summary-item">
                        <div class="summary-icon" style="background: linear-gradient(135deg, #fbbf24 0%, #f59e0b 100%);">
                            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                <path d="M22 16.92v3a2 2 0 01-2.18 2 19.79 19.79 0 01-8.63-3.07 19.5 19.5 0 01-6-6 19.79 19.79 0 01-3.07-8.67A2 2 0 014.11 2h3a2 2 0 012 1.72 12.84 12.84 0 00.7 2.81 2 2 0 01-.45 2.11L8.09 9.91a16 16 0 006 6l1.27-1.27a2 2 0 012.11-.45 12.84 12.84 0 002.81.7A2 2 0 0122 16.92z"></path>
                            </svg>
                        </div>
                        <div class="summary-content">
                            <div class="summary-label">Pending Calls</div>
                            <div class="summary-value">${pending_count}</div>
                        </div>
                    </div>
                    <div class="summary-item">
                        <div class="summary-icon" style="background: linear-gradient(135deg, #43e97b 0%, #38f9d7 100%);">
                            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                <path d="M22 11.08V12a10 10 0 11-5.93-9.14"></path>
                                <polyline points="22 4 12 14.01 9 11.01"></polyline>
                            </svg>
                        </div>
                        <div class="summary-content">
                            <div class="summary-label">Called</div>
                            <div class="summary-value">${called_count}</div>
                        </div>
                    </div>
                    <div class="summary-item">
                        <div class="summary-icon" style="background: linear-gradient(135deg, #ef4444 0%, #dc2626 100%);">
                            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                <path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"></path>
                                <line x1="12" y1="9" x2="12" y2="13"></line>
                                <line x1="12" y1="17" x2="12.01" y2="17"></line>
                            </svg>
                        </div>
                        <div class="summary-content">
                            <div class="summary-label">Not Picked</div>
                            <div class="summary-value">${not_picked_count}</div>
                        </div>
                    </div>
                    <div class="summary-item">
                        <div class="summary-icon" style="background: linear-gradient(135deg, #6b7280 0%, #374151 100%);">
                            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                <circle cx="12" cy="12" r="10"></circle>
                                <line x1="15" y1="9" x2="9" y2="15"></line>
                                <line x1="9" y1="9" x2="15" y2="15"></line>
                            </svg>
                        </div>
                        <div class="summary-content">
                            <div class="summary-label">Declined</div>
                            <div class="summary-value">${declined_count}</div>
                        </div>
                    </div>
                    <div class="summary-item">
                        <div class="summary-icon" style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);">
                            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                <line x1="12" y1="1" x2="12" y2="23"></line>
                                <path d="M17 5H9.5a3.5 3.5 0 000 7h5a3.5 3.5 0 010 7H6"></path>
                            </svg>
                        </div>
                        <div class="summary-content">
                            <div class="summary-label">Total Value</div>
                            <div class="summary-value">${format_currency(total_value)}</div>
                        </div>
                    </div>
                </div>
                
                <div class="table-wrapper">
                    <table class="table table-bordered modern-table">
                        <thead>
                            <tr>
                                <th width="4%"></th>
                                <th width="11%">Sales Order</th>
                                <th width="13%">Customer</th>
                                <th width="11%">Phone Number</th>
                                <th width="9%">Amount</th>
                                <th width="8%">Date</th>
                                <th width="10%">Region</th>
                                <th width="20%">Action</th>
                                <th width="10%">Status</th>
                            </tr>
                        </thead>
                        <tbody>
        `;

        // Group page-slice by truck for display
        const groups = {};
        filtered_orders.forEach(order => {
            const key = order.custom_truck_number || '__no_truck__';
            if (!groups[key]) groups[key] = [];
            groups[key].push(order);
        });
        const group_keys = Object.keys(groups).sort((a, b) => {
            if (a === '__no_truck__') return 1;
            if (b === '__no_truck__') return -1;
            return a.localeCompare(b);
        });

        group_keys.forEach(key => {
            const truck_label = key === '__no_truck__' ? 'No Truck Assigned' : `Truck: ${key}`;
            const grp = groups[key];
            html += `
                <tr class="oc-truck-header">
                    <td colspan="9">
                        ${key === '__no_truck__' ? '📋' : '🚛'} ${frappe.utils.escape_html(truck_label)}
                        <span style="font-weight:normal;color:#94a3b8;margin-left:10px;">${grp.length} order${grp.length !== 1 ? 's' : ''}</span>
                    </td>
                </tr>`;

            grp.forEach(order => {
                const is_called     = this.called_orders.has(order.name);
                const is_not_picked = this.not_picked_orders.has(order.name);
                const is_declined   = this.declined_orders.has(order.name);
                const is_actioned   = is_called || is_not_picked || is_declined;

                html += `
                <tr class="order-row ${is_called ? 'order-called' : ''} ${is_not_picked ? 'order-not-picked' : ''} ${is_declined ? 'order-declined' : ''}"
                    data-order="${order.name}">
                    <td>
                        <span class="toggle-details" style="cursor:pointer; font-size: 16px;">▶</span>
                    </td>
                    <td><a href="/app/sales-order/${order.name}" target="_blank" class="order-link">${order.name}</a></td>
                    <td><a href="/app/customer/${order.customer}" target="_blank" class="customer-link">${order.customer_name || order.customer}</a></td>
                    <td>
                        ${order.custom_phone_number ?
                            `<a href="tel:${order.custom_phone_number}" class="phone-link">
                                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align:middle;margin-right:4px;">
                                    <path d="M22 16.92v3a2 2 0 01-2.18 2 19.79 19.79 0 01-8.63-3.07 19.5 19.5 0 01-6-6 19.79 19.79 0 01-3.07-8.67A2 2 0 014.11 2h3a2 2 0 012 1.72 12.84 12.84 0 00.7 2.81 2 2 0 01-.45 2.11L8.09 9.91a16 16 0 006 6l1.27-1.27a2 2 0 012.11-.45 12.84 12.84 0 002.81.7A2 2 0 0122 16.92z"></path>
                                </svg>
                                ${order.custom_phone_number}
                            </a>` :
                            '<span class="text-muted">No phone</span>'}
                    </td>
                    <td><span class="amount-badge">${format_currency(order.grand_total)}</span></td>
                    <td>${frappe.datetime.str_to_user(order.transaction_date)}</td>
                    <td><span class="region-tag">${order.custom_delivery_region || '-'}</span></td>
                    <td>
                        <div class="action-buttons">
                            <button class="btn btn-sm ${is_called ? 'btn-success' : 'btn-primary'} btn-mark-called"
                                    data-order="${order.name}" ${is_actioned ? 'disabled' : ''}>
                                ${is_called ? '✓ Called' : 'Mark Called'}
                            </button>
                            <button class="btn btn-sm ${is_not_picked ? 'btn-danger' : 'btn-warning'} btn-not-picked"
                                    data-order="${order.name}" ${is_actioned ? 'disabled' : ''}>
                                ${is_not_picked ? '✓ Not Picked' : 'Not Picked'}
                            </button>
                            <button class="btn btn-sm ${is_declined ? 'btn-default' : 'btn-default'} btn-declined"
                                    data-order="${order.name}" ${is_actioned ? 'disabled' : ''}
                                    style="${is_declined ? 'color:#6b7280;' : 'color:#6b7280;border-color:#d1d5db;'}">
                                ${is_declined ? '✕ Declined' : 'Customer Declined'}
                            </button>
                        </div>
                    </td>
                    <td>
                        ${is_called ?
                            '<span class="status-badge status-called">Ready to Submit</span>' :
                        is_not_picked ?
                            '<span class="status-badge status-not-picked">Call Not Picked</span>' :
                        is_declined ?
                            '<span class="status-badge status-declined">Customer Declined</span>' :
                            '<span class="status-badge status-pending">Pending Call</span>'}
                    </td>
                </tr>
                <tr class="order-details-row" data-order="${order.name}" style="display:none;">
                    <td colspan="9">
                        <div class="order-details-container" style="padding:15px;background:#f8f9fa;">
                            <div class="loading">Loading details...</div>
                        </div>
                    </td>
                </tr>`;
            });
        });

        html += `
                        </tbody>
                    </table>
                    ${this._pagination_html(all_filtered.length)}
                </div>
            </div>

            ${this._render_late_notes_section()}

            <style>
                .oc-truck-header td {
                    background: #1e293b !important;
                    color: #f1f5f9 !important;
                    font-weight: 700;
                    font-size: 13px;
                    padding: 10px 14px !important;
                    border: none !important;
                    letter-spacing: .3px;
                }
                .oc-late-section {
                    margin-top: 32px;
                    background: #fff;
                    border-radius: 12px;
                    overflow: hidden;
                    box-shadow: 0 2px 8px rgba(0,0,0,.08);
                }
                .oc-late-header {
                    background: #0f172a;
                    color: #f1f5f9;
                    padding: 14px 20px;
                    font-weight: 700;
                    font-size: 15px;
                    display: flex;
                    align-items: center;
                    gap: 12px;
                }
                .oc-late-sub { font-size: 12px; color: #94a3b8; font-weight: 400; }
                .oc-late-table thead { background: #334155; }
                .oc-late-table thead th { color: #fff !important; font-size: 11px !important; text-transform: uppercase; letter-spacing: .4px; padding: 10px 12px !important; border: none !important; }
                .oc-late-table td { padding: 11px 12px !important; vertical-align: middle !important; font-size: 13px; }
                .oc-late-table tr:hover td { background: #f8fafc; }
                .oc-note-cell { color: #475569; font-style: italic; max-width: 240px; }
                .confirmation-orders-table { 
                    margin-top: 20px;
                    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
                }
                
                .summary-card {
                    display: grid;
                    grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
                    gap: 20px;
                    margin-bottom: 30px;
                }
                
                .summary-item {
                    background: white;
                    border-radius: 12px;
                    padding: 20px;
                    display: flex;
                    align-items: center;
                    gap: 15px;
                    box-shadow: 0 2px 8px rgba(0,0,0,0.08);
                    transition: transform 0.2s, box-shadow 0.2s;
                }
                
                .summary-item:hover {
                    transform: translateY(-2px);
                    box-shadow: 0 4px 12px rgba(0,0,0,0.12);
                }
                
                .summary-icon {
                    width: 50px;
                    height: 50px;
                    border-radius: 10px;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    color: white;
                    flex-shrink: 0;
                }
                
                .summary-content {
                    flex-grow: 1;
                }
                
                .summary-label {
                    font-size: 13px;
                    color: #6b7280;
                    margin-bottom: 4px;
                    font-weight: 500;
                }
                
                .summary-value {
                    font-size: 24px;
                    font-weight: 700;
                    color: #111827;
                }
                
                .table-wrapper {
                    background: white;
                    border-radius: 12px;
                    overflow: hidden;
                    box-shadow: 0 2px 8px rgba(0,0,0,0.08);
                }
                
                .modern-table {
                    margin-bottom: 0 !important;
                }
                
                .modern-table thead {
                    background: linear-gradient(135deg, #f093fb 0%, #f5576c 100%);
                }
                
                .modern-table thead th {
                    color: white !important;
                    font-weight: 600;
                    text-transform: uppercase;
                    font-size: 12px;
                    letter-spacing: 0.5px;
                    padding: 16px 12px !important;
                    border: none !important;
                }
                
                .order-row {
                    transition: all 0.2s;
                    border-left: 3px solid transparent;
                }
                
                .order-row:hover { 
                    background-color: #fef2f2 !important;
                    border-left-color: #f093fb;
                }
                
                .order-row.order-called {
                    background-color: #f0fdf4;
                }
                
                .order-row.order-called:hover {
                    background-color: #dcfce7 !important;
                    border-left-color: #43e97b;
                }
                
                .order-row.order-not-picked {
                    background-color: #fef2f2;
                }
                
                .order-row.order-not-picked:hover {
                    background-color: #fee2e2 !important;
                    border-left-color: #ef4444;
                }
                
                .order-row td {
                    padding: 14px 12px !important;
                    vertical-align: middle !important;
                }
                
                .action-buttons {
                    display: flex;
                    gap: 5px;
                    flex-wrap: wrap;
                }
                
                .action-buttons .btn {
                    font-size: 11px;
                    padding: 4px 10px;
                }
                
                .order-link, .customer-link {
                    color: #f093fb;
                    font-weight: 600;
                    text-decoration: none;
                    transition: color 0.2s;
                }
                
                .order-link:hover, .customer-link:hover {
                    color: #f5576c;
                    text-decoration: underline;
                }
                
                .phone-link {
                    color: #0891b2;
                    font-weight: 600;
                    text-decoration: none;
                    transition: color 0.2s;
                    display: inline-flex;
                    align-items: center;
                }
                
                .phone-link:hover {
                    color: #0e7490;
                    text-decoration: underline;
                }
                
                .amount-badge {
                    display: inline-block;
                    padding: 6px 12px;
                    border-radius: 6px;
                    font-weight: 600;
                    font-size: 13px;
                    background: linear-gradient(135deg, #667eea15 0%, #764ba215 100%);
                    color: #667eea;
                }
                
                .status-badge {
                    display: inline-block;
                    padding: 6px 12px;
                    border-radius: 20px;
                    font-size: 11px;
                    font-weight: 600;
                    text-transform: uppercase;
                    letter-spacing: 0.5px;
                }
                
                .status-called {
                    background: linear-gradient(135deg, #43e97b 0%, #38f9d7 100%);
                    color: white;
                }
                
                .status-pending {
                    background: linear-gradient(135deg, #fbbf24 0%, #f59e0b 100%);
                    color: white;
                }
                
                .status-not-picked {
                    background: linear-gradient(135deg, #ef4444 0%, #dc2626 100%);
                    color: white;
                }

                .status-declined {
                    background: linear-gradient(135deg, #6b7280 0%, #374151 100%);
                    color: white;
                }

                .order-row.order-declined {
                    opacity: 0.65;
                }

                .order-row.order-declined:hover {
                    background-color: #f9fafb !important;
                    border-left-color: #9ca3af;
                }
                
                .region-tag {
                    display: inline-block;
                    padding: 4px 10px;
                    background: #f3f4f6;
                    border-radius: 6px;
                    font-size: 12px;
                    color: #4b5563;
                    font-weight: 500;
                }
                
                .btn-mark-called, .btn-not-picked {
                    transition: all 0.2s;
                    font-weight: 600;
                }
                
                .btn-mark-called:not(:disabled):hover,
                .btn-not-picked:not(:disabled):hover {
                    transform: translateY(-1px);
                    box-shadow: 0 2px 8px rgba(0,0,0,0.15);
                }
                
                .toggle-details {
                    cursor: pointer;
                    transition: transform 0.2s;
                }
                
                .item-row { 
                    margin-bottom: 10px; 
                    padding: 12px; 
                    border: 1px solid #e5e7eb; 
                    border-radius: 8px;
                    background: white;
                }
                
                .item-header { 
                    font-weight: 600; 
                    margin-bottom: 8px;
                    color: #111827;
                    font-size: 14px;
                }
                
                .item-details { 
                    display: flex; 
                    gap: 20px; 
                    flex-wrap: wrap;
                    font-size: 13px;
                    color: #6b7280;
                }
                
                .item-details > span {
                    display: inline-block;
                }
                
                .item-details strong {
                    color: #374151;
                }
                
                .notes-section {
                    margin-top: 15px;
                    padding-top: 15px;
                    border-top: 2px solid #e5e7eb;
                }
                
                .notes-section h4 {
                    font-size: 14px;
                    font-weight: 600;
                    color: #111827;
                    margin-bottom: 10px;
                }
                
                .notes-display {
                    background: white;
                    padding: 10px;
                    border-radius: 6px;
                    border: 1px solid #e5e7eb;
                    color: #6b7280;
                    font-size: 13px;
                    font-style: italic;
                }
                .oc-pg-bar {
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    gap: 14px;
                    padding: 12px 16px;
                    border-top: 1px solid #e5e7eb;
                    background: #f9fafb;
                }
                .oc-pg-info { font-size: 13px; color: #6b7280; }
                .oc-pg-bar .btn { min-width: 70px; }
            </style>
        `;

        this.container.html(html);
        this.attach_events();
    }

    _render_late_notes_section() {
        if (!this.submitted_orders.length) return '';

        const rows = this.submitted_orders.map(o => `
            <tr>
                <td><a href="/app/sales-order/${o.name}" target="_blank" class="order-link">${o.name}</a></td>
                <td>${frappe.utils.escape_html(o.customer_name || o.name)}</td>
                <td>${o.custom_phone_number
                    ? `<a href="tel:${o.custom_phone_number}" class="phone-link">${o.custom_phone_number}</a>`
                    : '<span class="text-muted">—</span>'}
                </td>
                <td>${o.custom_truck_number
                    ? `<span class="region-tag">${frappe.utils.escape_html(o.custom_truck_number)}</span>`
                    : '<span class="text-muted">—</span>'}
                </td>
                <td class="oc-note-cell">
                    ${o.custom_call_notes
                        ? frappe.utils.escape_html(o.custom_call_notes)
                        : '<span class="text-muted">No note yet</span>'}
                </td>
                <td>
                    <button class="btn btn-xs ${o.custom_call_notes ? 'btn-default' : 'btn-primary'} btn-add-late-note"
                            data-order="${o.name}">
                        ${o.custom_call_notes ? 'Edit Note' : 'Add Note'}
                    </button>
                </td>
            </tr>`).join('');

        return `
        <div class="oc-late-section">
            <div class="oc-late-header">
                📞 Late Call Notes
                <span class="oc-late-sub">Add notes after submission — for customers who called back or picked up late</span>
            </div>
            <table class="table table-bordered oc-late-table" style="margin:0;">
                <thead><tr>
                    <th width="12%">Order</th>
                    <th width="18%">Customer</th>
                    <th width="13%">Phone</th>
                    <th width="10%">Truck</th>
                    <th width="30%">Call Note</th>
                    <th width="12%">Action</th>
                </tr></thead>
                <tbody>${rows}</tbody>
            </table>
        </div>`;
    }

    add_late_note(order_name) {
        const order = this.submitted_orders.find(o => o.name === order_name);
        frappe.prompt([{
            label: 'Call Notes',
            fieldname: 'call_notes',
            fieldtype: 'Small Text',
            default: order ? (order.custom_call_notes || '') : '',
            description: 'Log the outcome of this late call or callback',
        }], (vals) => {
            frappe.call({
                method: 'frappe.client.set_value',
                args: {
                    doctype: 'Sales Order',
                    name: order_name,
                    fieldname: { custom_call_notes: vals.call_notes || '' },
                },
                callback: (r) => {
                    if (!r.message) return;
                    if (order) order.custom_call_notes = vals.call_notes;
                    frappe.show_alert({ message: __('Note saved for {0}', [order_name]), indicator: 'green' });

                    // Update the note cell and button label without a full re-render
                    const $row = this.container.find(`.btn-add-late-note[data-order="${order_name}"]`).closest('tr');
                    $row.find('.oc-note-cell').text(vals.call_notes || '');
                    $row.find('.btn-add-late-note')
                        .text('Edit Note')
                        .removeClass('btn-primary').addClass('btn-default');
                },
            });
        }, __('Late Call Note — {0}', [order_name]), __('Save Note'));
    }

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
            self.current_page = 1; self.load_data();
        });
    }

    _pagination_html(total) {
        if (total <= this.page_size) return '';
        const total_pages = Math.ceil(total / this.page_size);
        const start = (this.current_page - 1) * this.page_size + 1;
        const end   = Math.min(this.current_page * this.page_size, total);
        return `<div class="oc-pg-bar">
            <button class="btn btn-xs btn-default oc-pg-prev" ${this.current_page <= 1 ? 'disabled' : ''}>&lsaquo; Prev</button>
            <span class="oc-pg-info">Showing ${start}–${end} of ${total} &nbsp;·&nbsp; Page ${this.current_page} of ${total_pages}</span>
            <button class="btn btn-xs btn-default oc-pg-next" ${this.current_page >= total_pages ? 'disabled' : ''}>Next &rsaquo;</button>
        </div>`;
    }

    attach_events() {
        const self = this;

        // Pagination
        this.container.find('.oc-pg-prev').on('click', () => {
            if (this.current_page > 1) { this.current_page--; this.render_orders(); }
        });
        this.container.find('.oc-pg-next').on('click', () => {
            const tp = Math.ceil(this.get_filtered_orders().length / this.page_size);
            if (this.current_page < tp) { this.current_page++; this.render_orders(); }
        });

        // Toggle details
        this.container.find('.toggle-details').off('click').on('click', function(e) {
            e.stopPropagation();
            const $icon = $(this);
            const order_name = $icon.closest('tr').data('order');
            const $details_row = $(`.order-details-row[data-order="${order_name}"]`);
            
            if ($details_row.is(':visible')) {
                $details_row.hide();
                $icon.text('▶');
            } else {
                $details_row.show();
                $icon.text('▼');
                self.load_order_items(order_name);
            }
        });

        // Late call notes
        this.container.find('.btn-add-late-note').off('click').on('click', function () {
            self.add_late_note($(this).data('order'));
        });

        // Mark as called
        this.container.find('.btn-mark-called').off('click').on('click', function() {
            const order_name = $(this).data('order');
            self.mark_as_called(order_name, $(this));
        });

        // Mark as not picked
        this.container.find('.btn-not-picked').off('click').on('click', function() {
            const order_name = $(this).data('order');
            self.mark_as_not_picked(order_name, $(this));
        });

        // Customer declined
        this.container.find('.btn-declined').off('click').on('click', function() {
            const order_name = $(this).data('order');
            self.mark_as_declined(order_name, $(this));
        });
    }

    load_order_items(order_name) {
        const $container = $(`.order-details-row[data-order="${order_name}"] .order-details-container`);
        $container.html('<div class="loading">Loading…</div>');
        frappe.call({
            method: 'frappe.client.get',
            args: { doctype: 'Sales Order', name: order_name },
            callback: (r) => {
                if (r.message) {
                    this._editor_items[order_name] = r.message.items.map(i => ({ ...i }));
                    this.render_order_editor($container, order_name, this._editor_items[order_name]);
                }
            }
        });
    }

    _editor_total(items) {
        return items.reduce((s, i) => s + flt(i.qty) * flt(i.rate), 0);
    }

    render_order_editor($container, order_name, items) {
        const rows = items.map((item, idx) => this._item_editor_row(item, idx)).join('');
        const total = this._editor_total(items);
        $container.html(`
            <div class="oc-editor">
                <table class="table table-bordered oc-editor-table">
                    <thead><tr>
                        <th>Item Code</th><th>Description</th>
                        <th width="110px">Qty</th><th width="110px">Rate</th>
                        <th width="110px">Amount</th><th width="40px"></th>
                    </tr></thead>
                    <tbody class="oc-items-tbody">${rows}</tbody>
                    <tfoot>
                        <tr style="background:#1e293b;">
                            <td colspan="4" style="text-align:right;font-weight:700;color:#fff;font-size:13px;padding:10px 12px!important;">
                                Order Total
                            </td>
                            <td class="oc-editor-total" style="font-weight:700;color:#43e97b;font-size:15px;padding:10px 12px!important;">
                                ${format_currency(total)}
                            </td>
                            <td style="background:#1e293b;"></td>
                        </tr>
                    </tfoot>
                </table>
                <div class="oc-editor-actions">
                    <button class="btn btn-xs btn-default oc-add-item-btn">+ Add Item</button>
                    <span style="flex:1;"></span>
                    <button class="btn btn-sm btn-primary oc-save-btn">Save Changes</button>
                    <button class="btn btn-sm btn-danger oc-cancel-order-btn">Cancel Order</button>
                    <span class="oc-save-status"></span>
                </div>
            </div>
            <style>
                .oc-editor-table { margin-bottom: 8px !important; font-size: 13px; }
                .oc-editor-table th { background: #1e293b; color: #fff !important; font-size: 11px; padding: 8px 10px !important; border: none !important; }
                .oc-editor-table td { padding: 7px 10px !important; vertical-align: middle !important; }
                .oc-editor-actions { display: flex; gap: 8px; align-items: center; padding: 6px 0; flex-wrap: wrap; }
                .oc-save-status { font-size: 12px; color: #6b7280; }
                .oc-qty-input { width: 80px; text-align: right; }
                .oc-item-row-new td { background: #f0fdf4; }
            </style>
        `);
        this._attach_editor_events($container, order_name);
    }

    _item_editor_row(item, idx) {
        const delivered = flt(item.delivered_qty);
        const is_new    = !item.name;
        return `<tr class="oc-item-row ${is_new ? 'oc-item-row-new' : ''}"
                    data-name="${frappe.utils.escape_html(item.name || '')}"
                    data-idx="${idx}">
            <td><strong>${frappe.utils.escape_html(item.item_code)}</strong></td>
            <td>${frappe.utils.escape_html(item.item_name || '')}</td>
            <td>
                <input type="number" class="form-control input-sm oc-qty-input"
                       value="${item.qty}" min="${delivered}" step="0.001"
                       ${delivered > 0 ? `title="Minimum ${delivered} already delivered"` : ''}>
            </td>
            <td>${format_currency(item.rate, null, 2)}</td>
            <td class="oc-row-amount">${format_currency(flt(item.qty) * flt(item.rate), null, 0)}</td>
            <td style="text-align:center;">
                ${delivered > 0
                    ? `<span style="font-size:10px;color:#9ca3af;">Del.</span>`
                    : `<button class="btn btn-xs btn-danger oc-remove-row-btn" title="Remove item">✕</button>`}
            </td>
        </tr>`;
    }

    _attach_editor_events($container, order_name) {
        const self = this;

        // Live amount recalc
        $container.on('input', '.oc-qty-input', function () {
            const $row = $(this).closest('tr');
            const idx  = parseInt($row.data('idx'), 10);
            const qty  = parseFloat($(this).val()) || 0;
            const items = self._editor_items[order_name];
            if (items && items[idx]) items[idx].qty = qty;
            const rate = items && items[idx] ? flt(items[idx].rate) : 0;
            $row.find('.oc-row-amount').text(format_currency(qty * rate, null, 0));
            $container.find('.oc-editor-total').text(format_currency(self._editor_total(items || [])));
        });

        // Remove item row
        $container.on('click', '.oc-remove-row-btn', function () {
            const $row = $(this).closest('tr');
            const idx  = parseInt($row.data('idx'), 10);
            const items = self._editor_items[order_name];
            if (items) items.splice(idx, 1);
            // Re-render tbody
            const rows = (self._editor_items[order_name] || []).map((item, i) => self._item_editor_row(item, i)).join('');
            $container.find('.oc-items-tbody').html(rows || '<tr><td colspan="6" style="text-align:center;color:#9ca3af;">No items</td></tr>');
            $container.find('.oc-editor-total').text(format_currency(self._editor_total(self._editor_items[order_name] || [])));
            self._attach_editor_events($container, order_name);
        });

        // Add item
        $container.on('click', '.oc-add-item-btn', function () {
            self._show_add_item_dialog(order_name, $container);
        });

        // Save changes
        $container.on('click', '.oc-save-btn', function () {
            self._save_order_changes(order_name, $container);
        });

        // Cancel order
        $container.on('click', '.oc-cancel-order-btn', function () {
            frappe.prompt([{
                label: 'Reason for Cancellation',
                fieldname: 'reason',
                fieldtype: 'Small Text',
                description: 'Optional — will be saved on the order for reference',
            }], (vals) => {
                self._do_cancel_order(order_name, vals.reason || '');
            }, __('Cancel Order — {0}', [order_name]), __('Confirm Cancellation'));
        });
    }

    _show_add_item_dialog(order_name, $container) {
        const d = new frappe.ui.Dialog({
            title: __('Add Item'),
            fields: [
                { label: 'Item Code', fieldname: 'item_code', fieldtype: 'Link', options: 'Item', reqd: 1,
                  onchange: function () {
                      const ic = d.get_value('item_code');
                      if (!ic) return;
                      frappe.call({
                          method: 'crystal_custom.crystal_customizations.page.customer_order_confi.customer_order_confi.get_item_details',
                          args: { item_code: ic },
                          callback: r => {
                              if (!r.message) return;
                              d.set_value('item_name', r.message.item_name);
                              d.set_value('uom',       r.message.uom);
                              d.set_value('rate',      r.message.rate);
                          },
                      });
                  }
                },
                { label: 'Description', fieldname: 'item_name', fieldtype: 'Data', read_only: 1 },
                { label: 'Qty',  fieldname: 'qty',  fieldtype: 'Float', default: 1 },
                { label: 'Rate', fieldname: 'rate', fieldtype: 'Currency' },
                { label: 'UOM',  fieldname: 'uom',  fieldtype: 'Data', read_only: 1 },
            ],
            primary_action_label: __('Add'),
            primary_action: (vals) => {
                if (!vals.item_code || !vals.qty) {
                    frappe.msgprint(__('Item and Qty are required'));
                    return;
                }
                const items = this._editor_items[order_name] = this._editor_items[order_name] || [];
                items.push({
                    name:            null,
                    item_code:       vals.item_code,
                    item_name:       vals.item_name || vals.item_code,
                    qty:             flt(vals.qty),
                    delivered_qty:   0,
                    rate:            flt(vals.rate),
                    amount:          flt(vals.qty) * flt(vals.rate),
                    uom:             vals.uom || '',
                    weight_per_unit: 0,
                });
                const rows = items.map((item, i) => this._item_editor_row(item, i)).join('');
                $container.find('.oc-items-tbody').html(rows);
                this._attach_editor_events($container, order_name);
                d.hide();
            },
        });
        d.show();
    }

    _save_order_changes(order_name, $container) {
        const items = this._editor_items[order_name] || [];
        if (!items.length) {
            frappe.msgprint(__('An order must have at least one item. Use Cancel Order to remove it entirely.'));
            return;
        }

        const payload = items.map(i => ({
            name:      i.name || null,
            item_code: i.item_code,
            qty:       flt(i.qty),
            rate:      flt(i.rate),
            uom:       i.uom || '',
        }));

        $container.find('.oc-save-status').text('Saving…');
        frappe.call({
            method: 'crystal_custom.crystal_customizations.page.customer_order_confi.customer_order_confi.save_order_changes',
            args: { order_name, items_json: JSON.stringify(payload) },
            callback: r => {
                if (!r.message || r.message.status !== 'ok') {
                    $container.find('.oc-save-status').text('');
                    frappe.msgprint({
                        title: __('Save failed'),
                        message: __('Could not save {0}. Please reload and try again.', [order_name]),
                        indicator: 'red',
                    });
                    return;
                }
                const msg = r.message;

                // Update local items list with server-assigned names for new rows
                this._editor_items[order_name] = msg.items;

                // Refresh the tbody so new items have server names
                const rows = msg.items.map((item, i) => this._item_editor_row(item, i)).join('');
                $container.find('.oc-items-tbody').html(rows);
                this._attach_editor_events($container, order_name);

                // Update the order row's displayed amount
                const $amount = $(`.order-row[data-order="${order_name}"] .amount-badge`);
                $amount.text(format_currency(msg.grand_total));

                // Update local orders array
                const o = this.orders.find(x => x.name === order_name);
                if (o) { o.grand_total = msg.grand_total; o.total_net_weight = msg.total_net_weight; }

                $container.find('.oc-save-status').text('✓ Saved');
                setTimeout(() => $container.find('.oc-save-status').text(''), 3000);
                frappe.show_alert({ message: __('Order {0} updated', [order_name]), indicator: 'green' });
            },
            error: (err) => {
                $container.find('.oc-save-status').text('');
                // Extract the most useful error text from Frappe's error response
                let detail = '';
                try {
                    const msgs = JSON.parse(err._server_messages || '[]');
                    detail = msgs.map(m => {
                        try { return JSON.parse(m).message; } catch(e) { return m; }
                    }).join('\n');
                } catch(e) { /* ignore */ }
                frappe.msgprint({
                    title: __('Save failed — {0}', [order_name]),
                    message: detail || err.exc || __('An error occurred. Check browser console for details.'),
                    indicator: 'red',
                });
            },
        });
    }

    _do_cancel_order(order_name, reason) {
        frappe.call({
            method: 'crystal_custom.crystal_customizations.page.customer_order_confi.customer_order_confi.cancel_order',
            args: { order_name, reason },
            callback: r => {
                if (!r.message) return;
                // Remove from local list and re-render
                this.orders = this.orders.filter(o => o.name !== order_name);
                delete this._editor_items[order_name];
                this.called_orders.delete(order_name);
                this.not_picked_orders.delete(order_name);
                frappe.show_alert({ message: __('Order {0} cancelled', [order_name]), indicator: 'orange' });
                this.render_orders();
            },
        });
    }

    mark_as_called(order_name, $btn) {
        // If order was previously marked as not picked, clear that status
        const was_not_picked = this.not_picked_orders.has(order_name);
        
        if (was_not_picked) {
            // Clear the not picked status in database
            frappe.call({
                method: 'frappe.client.set_value',
                args: {
                    doctype: 'Sales Order',
                    name: order_name,
                    fieldname: {
                        custom_call_not_picked: 0,
                        custom_call_notes: ''
                    }
                },
                callback: (r) => {
                    if (r.message) {
                        this.not_picked_orders.delete(order_name);
                        this.complete_call_marking(order_name, $btn);
                    }
                }
            });
        } else {
            this.complete_call_marking(order_name, $btn);
        }
    }

    complete_call_marking(order_name, $btn) {
        this.called_orders.add(order_name);
        
        $btn.removeClass('btn-primary').addClass('btn-success')
            .text('✓ Called')
            .prop('disabled', true);
        
        // Disable "Not Picked" button
        $btn.closest('.action-buttons').find('.btn-not-picked')
            .removeClass('btn-danger')
            .addClass('btn-warning')
            .text('Not Picked')
            .prop('disabled', true);
        
        $(`.order-row[data-order="${order_name}"]`)
            .removeClass('order-not-picked')
            .addClass('order-called')
            .find('.status-badge')
            .removeClass('status-pending status-not-picked')
            .addClass('status-called')
            .text('Ready to Submit');
        
        frappe.show_alert({
            message: __('Order marked as called'),
            indicator: 'green'
        });
    }

    mark_as_not_picked(order_name, $btn) {
        frappe.prompt([
            {
                label: 'Notes',
                fieldname: 'call_notes',
                fieldtype: 'Small Text',
                description: 'Optional: Add notes about why the call was not picked'
            }
        ],
        (values) => {
            this.not_picked_orders.add(order_name);
            
            // Update the order in database
            frappe.call({
                method: 'frappe.client.set_value',
                args: {
                    doctype: 'Sales Order',
                    name: order_name,
                    fieldname: {
                        custom_call_not_picked: 1,
                        custom_call_notes: values.call_notes || ''
                    }
                },
                callback: (r) => {
                    if (r.message) {
                        $btn.removeClass('btn-warning').addClass('btn-danger')
                            .text('✓ Not Picked')
                            .prop('disabled', true);
                        
                        // Disable "Mark Called" button
                        $btn.closest('.action-buttons').find('.btn-mark-called').prop('disabled', true);
                        
                        $(`.order-row[data-order="${order_name}"]`)
                            .removeClass('order-called')
                            .addClass('order-not-picked')
                            .find('.status-badge')
                            .removeClass('status-pending status-called')
                            .addClass('status-not-picked')
                            .text('Call Not Picked');
                        
                        frappe.show_alert({
                            message: __('Order marked as not picked'),
                            indicator: 'orange'
                        });
                    }
                }
            });
        },
        __('Call Not Picked - Add Notes'),
        __('Save')
        );
    }

    mark_as_declined(order_name, $btn) {
        frappe.prompt([{
            label: 'Reason for declining (optional)',
            fieldname: 'reason',
            fieldtype: 'Small Text',
            description: 'This will be saved on the order as a call note',
        }], (vals) => {
            // Optimistic UI: mark locally and disable buttons immediately
            this.declined_orders.add(order_name);
            const $row = $(`.order-row[data-order="${order_name}"]`);
            $row.addClass('order-declined')
                .find('.action-buttons .btn').prop('disabled', true);
            $row.find('.status-badge')
                .removeClass('status-pending status-called status-not-picked')
                .addClass('status-declined')
                .text('Customer Declined');
            $btn.text('✕ Declined');

            const reason = vals.reason ? `Customer declined — ${vals.reason}` : 'Customer declined';
            frappe.call({
                method: 'crystal_custom.crystal_customizations.page.customer_order_confi.customer_order_confi.cancel_order',
                args: { order_name, reason },
                callback: (r) => {
                    if (!r.message) return;
                    // Remove from local orders list
                    this.orders = this.orders.filter(o => o.name !== order_name);
                    this.called_orders.delete(order_name);
                    this.not_picked_orders.delete(order_name);
                    this.declined_orders.delete(order_name);
                    delete this._editor_items[order_name];
                    frappe.show_alert({
                        message: __('Order {0} declined and cancelled', [order_name]),
                        indicator: 'orange',
                    });
                    this.render_orders();
                },
                error: () => {
                    // Rollback optimistic update on failure
                    this.declined_orders.delete(order_name);
                    this.render_orders();
                    frappe.msgprint({ title: __('Error'), message: __('Could not cancel order {0}. Please try again.', [order_name]), indicator: 'red' });
                },
            });
        }, __('Customer Declined — {0}', [order_name]), __('Decline Order'));
    }

    submit_orders(order_list, label) {
        if (!order_list.length) {
            frappe.msgprint(__('No {0} orders to submit.', [label]));
            return;
        }

        // Build a checklist so the user can unselect edge-case orders before submitting
        const order_objs = this.orders.filter(o => order_list.includes(o.name));
        const rows_html  = order_objs.map(o => `
            <div style="display:flex;align-items:center;gap:10px;padding:7px 0;border-bottom:1px solid #f1f5f9;">
                <input type="checkbox" class="oc-submit-chk" value="${o.name}" checked
                       style="width:15px;height:15px;accent-color:#667eea;flex-shrink:0;cursor:pointer;">
                <div style="flex:1;min-width:0;">
                    <div style="font-weight:600;font-size:13px;">${o.name}</div>
                    <div style="font-size:11px;color:#6b7280;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">
                        ${frappe.utils.escape_html(o.customer_name || o.customer)}
                    </div>
                </div>
                <div style="font-size:12px;color:#374151;white-space:nowrap;">${format_currency(o.grand_total, null, 0)}</div>
            </div>`).join('');

        const d = new frappe.ui.Dialog({
            title: __('Submit {0} Order(s)', [label]),
            fields: [{
                fieldtype: 'HTML',
                fieldname: 'order_list_html',
                options: `
                    <div style="margin-bottom:10px;display:flex;align-items:center;gap:8px;">
                        <input type="checkbox" id="oc-select-all-submit" checked
                               style="width:14px;height:14px;accent-color:#667eea;cursor:pointer;">
                        <label for="oc-select-all-submit" style="font-size:12px;color:#6b7280;cursor:pointer;margin:0;">
                            Select all / deselect all
                        </label>
                    </div>
                    <div style="max-height:320px;overflow-y:auto;padding-right:4px;">${rows_html}</div>
                    <div style="margin-top:10px;font-size:11px;color:#94a3b8;">
                        Uncheck any orders you want to hold back — they stay "Called" and can be submitted later.
                    </div>`,
            }],
            primary_action_label: __('Submit Selected'),
            primary_action: () => {
                const selected = [];
                d.$wrapper.find('.oc-submit-chk:checked').each((_, el) => selected.push($(el).val()));
                d.hide();
                if (!selected.length) {
                    frappe.msgprint(__('No orders selected — nothing was submitted.'));
                    return;
                }
                this.process_confirmations(selected);
            },
        });
        d.show();

        // Wire up select-all toggle
        d.$wrapper.find('#oc-select-all-submit').on('change', function () {
            d.$wrapper.find('.oc-submit-chk').prop('checked', $(this).is(':checked'));
        });
        d.$wrapper.find('.oc-submit-chk').on('change', function () {
            const total   = d.$wrapper.find('.oc-submit-chk').length;
            const checked = d.$wrapper.find('.oc-submit-chk:checked').length;
            d.$wrapper.find('#oc-select-all-submit').prop('checked', total === checked);
        });
    }

    process_confirmations(order_list) {
        let processed = 0;
        let errors = [];

        const process_next = () => {
            if (processed >= order_list.length) {
                if (errors.length > 0) {
                    frappe.msgprint({
                        title: __('Confirmation Complete with Errors'),
                        message: __('Successfully confirmed {0} orders. {1} failed:<br>{2}', 
                            [order_list.length - errors.length, errors.length, errors.join('<br>')]),
                        indicator: 'orange'
                    });
                } else {
                    frappe.msgprint({
                        title: __('Success'),
                        message: __('All {0} orders confirmed and submitted', [order_list.length]),
                        indicator: 'green'
                    });
                }
                this.called_orders.clear();
                this.load_data();
                return;
            }

            const order_name = order_list[processed];
            
            // Use frappe.xcall to properly submit the document
            frappe.call({
                method: 'frappe.client.get',
                args: {
                    doctype: 'Sales Order',
                    name: order_name
                },
                callback: (r) => {
                    if (!r.message) {
                        console.error('Failed to get order:', order_name);
                        errors.push(order_name + ' (failed to load)');
                        processed++;
                        process_next();
                        return;
                    }

                    const doc = r.message;
                    console.log('Processing order:', order_name, 'Current docstatus:', doc.docstatus);
                    
                    // Update workflow state
                    doc.workflow_state = 'Order Confirmed';
                    
                    // Save first
                    frappe.call({
                        method: 'frappe.client.save',
                        args: {
                            doc: doc
                        },
                        callback: (r2) => {
                            if (!r2.message) {
                                console.error('Save failed for:', order_name);
                                errors.push(order_name + ' (save failed)');
                                processed++;
                                process_next();
                                return;
                            }

                            console.log('Saved order:', order_name, 'Now submitting...');
                            
                            // Now submit using the saved document
                            frappe.call({
                                method: 'frappe.client.submit',
                                args: {
                                    doc: r2.message
                                },
                                callback: (r3) => {
                                    if (r3.message) {
                                        console.log('Successfully submitted:', order_name);
                                        frappe.show_alert({
                                            message: __('✓ Confirmed & Submitted {0}', [order_name]),
                                            indicator: 'green'
                                        });
                                    } else {
                                        console.error('Submit returned no message for:', order_name);
                                        errors.push(order_name + ' (submit returned empty)');
                                    }
                                    processed++;
                                    process_next();
                                },
                                error: (err) => {
                                    console.error('Submit error for', order_name, ':', err);
                                    const error_msg = err.exc || err.message || err._server_messages || 'Unknown error';
                                    errors.push(order_name + ' (submit failed: ' + error_msg + ')');
                                    processed++;
                                    process_next();
                                }
                            });
                        },
                        error: (err) => {
                            console.error('Save error for', order_name, ':', err);
                            const error_msg = err.exc || err.message || err._server_messages || 'Unknown error';
                            errors.push(order_name + ' (save failed: ' + error_msg + ')');
                            processed++;
                            process_next();
                        }
                    });
                },
                error: (err) => {
                    console.error('Get error for', order_name, ':', err);
                    errors.push(order_name + ' (failed to load)');
                    processed++;
                    process_next();
                }
            });
        };

        frappe.show_alert({
            message: __('Confirming and submitting {0} orders...', [order_list.length]),
            indicator: 'blue'
        });

        process_next();
    }
}