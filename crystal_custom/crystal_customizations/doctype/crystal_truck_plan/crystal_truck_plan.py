import frappe
from frappe.model.document import Document
from frappe.utils import flt


class CrystalTruckPlan(Document):
    def before_save(self):
        self.order_count = len(self.orders)
        self.total_weight = sum(row.total_net_weight or 0 for row in self.orders)
        self.total_value = sum(row.grand_total or 0 for row in self.orders)
        regions = sorted({row.delivery_region for row in self.orders if row.delivery_region})
        self.delivery_regions = ', '.join(regions)


@frappe.whitelist()
def make_delivery_manifest(source_name):
    """
    Create a Vehicle Delivery Manifest from a submitted Crystal Truck Plan
    """
    existing_manifest = frappe.db.get_value(
        "Vehicle Delivery Manifest",
        {"truck_plan": source_name, "docstatus": ["<", 2]},
        "name",
    )

    if existing_manifest:
        return {
            "status": "exists",
            "manifest_id": existing_manifest,
            "message": "A Delivery Manifest already exists for this Truck Plan.",
        }

    source = frappe.get_doc("Crystal Truck Plan", source_name)
    target = frappe.new_doc("Vehicle Delivery Manifest")

    target.truck_plan = source.name
    target.trip_status = "Manifested"

    target.profit_loss = source.narrowed_gross_profit
    target.gross_margin = source.narrowed_gross_margin_percentage
    target.approximate_total_distance_km = source.approximate_total_distance_km
    target.approximate_fuel_consumption_ltrs = source.approximate_fuel_consumption_ltrs
    target.approximate_fuel_cost = source.approximate_fuel_cost
    target.actual_fuel_fuelled = source.actual_fuel_fuelled
    target.profitability_status = source.profitability_status
    target.route_geojson = source.route_geojson

    for order_row in source.orders:
        so_doc = frappe.get_doc("Sales Order", order_row.sales_order)

        cust_lat = 0.0
        cust_lng = 0.0
        if so_doc.customer:
            cust_lat = flt(frappe.db.get_value("Customer", so_doc.customer, "custom_latitude"))
            cust_lng = flt(frappe.db.get_value("Customer", so_doc.customer, "custom_longitude"))

        target.append("stops", {
            "sales_order": so_doc.name,
            "customer": order_row.customer_name or so_doc.customer,
            "payment_terms": so_doc.payment_terms_template or "",
            "grand_total": so_doc.grand_total,
            "currency": so_doc.currency,
            "weight_kg": order_row.total_net_weight,
            "delivery_status": "Pending",
            "latitude": cust_lat,
            "longitude": cust_lng,
        })

    target.insert(ignore_permissions=True)
    frappe.db.commit()

    return {
        "status": "success",
        "manifest_id": target.name,
        "message": "Vehicle Delivery Manifest drafted successfully.",
    }




