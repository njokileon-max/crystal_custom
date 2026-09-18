// Copyright (c) 2026, Administrator and contributors
// For license information, please see license.txt

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
        }
    }
});

