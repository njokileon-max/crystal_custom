## [1.36.1](https://github.com/wanguimbutu/crystal_custom/compare/v1.36.0...v1.36.1) (2026-09-22)


### Bug Fixes

* add auto-close option in truck plan ([3c40988](https://github.com/wanguimbutu/crystal_custom/commit/3c40988f0809a0b44674efb9b32fc1a333ea8b6e))

# [1.36.0](https://github.com/wanguimbutu/crystal_custom/compare/v1.35.2...v1.36.0) (2026-09-18)


### Features

* changes to much the sales app ([4d7cff3](https://github.com/wanguimbutu/crystal_custom/commit/4d7cff3217adc66e2fb380241baae7ec2050a6a3))

## [1.35.2](https://github.com/wanguimbutu/crystal_custom/compare/v1.35.1...v1.35.2) (2026-08-20)


### Bug Fixes

* **truck-assignment:** surface orphaned orders from closed/dismantled trucks ([bb6b996](https://github.com/wanguimbutu/crystal_custom/commit/bb6b9969e8bd6b672cd9040577484dcad6d0b565))

## [1.35.1](https://github.com/wanguimbutu/crystal_custom/compare/v1.35.0...v1.35.1) (2026-08-20)


### Bug Fixes

* **truck-assignment:** show submitted orders needing truck regardless of date filter ([7825ca4](https://github.com/wanguimbutu/crystal_custom/commit/7825ca4690658e7409c39ccc5e1258c1bb742212))

# [1.35.0](https://github.com/wanguimbutu/crystal_custom/compare/v1.34.0...v1.35.0) (2026-08-20)


### Features

* **truck-assignment:** highlight overdue orders with no delivery note or invoice ([51853ec](https://github.com/wanguimbutu/crystal_custom/commit/51853ecc9901b5894b8da7dcc7956c871ce33fe6))

# [1.34.0](https://github.com/wanguimbutu/crystal_custom/compare/v1.33.3...v1.34.0) (2026-08-12)


### Features

* **item-order-fulfillment:** separate Truck and Delivery Region columns in search results ([f988087](https://github.com/wanguimbutu/crystal_custom/commit/f9880877440745463382f6c69b64696a53a29ed2))

## [1.33.3](https://github.com/wanguimbutu/crystal_custom/compare/v1.33.2...v1.33.3) (2026-08-11)


### Bug Fixes

* **item-order-fulfillment:** fix item name search in truck view ([8792be7](https://github.com/wanguimbutu/crystal_custom/commit/8792be7206ba68e701454445df22bc815412a8a7))
* restore get_closed_trucks as backward-compat alias for delivery and status pages ([09da307](https://github.com/wanguimbutu/crystal_custom/commit/09da307e0aeba6dc24c02113d8b9d8e65df3f82e))

## [1.33.2](https://github.com/wanguimbutu/crystal_custom/compare/v1.33.1...v1.33.2) (2026-08-11)


### Bug Fixes

* remove wrong confirmed filter ([3edb829](https://github.com/wanguimbutu/crystal_custom/commit/3edb82964d4724691868fa0467420f069ca8e6b6))

## [1.33.1](https://github.com/wanguimbutu/crystal_custom/compare/v1.33.0...v1.33.1) (2026-08-11)


### Bug Fixes

* filter fix ([1915169](https://github.com/wanguimbutu/crystal_custom/commit/1915169a5eb46fa2424acc57220aa63a1b192902))

# [1.33.0](https://github.com/wanguimbutu/crystal_custom/compare/v1.32.0...v1.33.0) (2026-08-11)


### Features

* **truck-assignment:** include truck number in order search ([1853a47](https://github.com/wanguimbutu/crystal_custom/commit/1853a47f2d99a9f276955764ac507c9e1a9a4f10))

# [1.32.0](https://github.com/wanguimbutu/crystal_custom/compare/v1.31.0...v1.32.0) (2026-08-11)


### Features

* **truck-assignment:** show total weight and value of selected orders ([5bfba7b](https://github.com/wanguimbutu/crystal_custom/commit/5bfba7b0ca862db10dd8dcfd9e5c7cc3e22cd340))

# [1.31.0](https://github.com/wanguimbutu/crystal_custom/compare/v1.30.0...v1.31.0) (2026-08-10)


### Features

* truck plan/ settings ([cb35921](https://github.com/wanguimbutu/crystal_custom/commit/cb35921fa46a9cb6b2b23a01f0f06c02db1b38b1))

# [1.30.0](https://github.com/wanguimbutu/crystal_custom/compare/v1.29.0...v1.30.0) (2026-08-10)


### Bug Fixes

* **customer-order-confirmation:** preserve cancelled orders instead of deleting ([d67c026](https://github.com/wanguimbutu/crystal_custom/commit/d67c026908ab71bb2bd4c7a13374cdcf8e329032))


### Features

* add truck route optimizer ([1e235ec](https://github.com/wanguimbutu/crystal_custom/commit/1e235ec2bbe8ab3952717926e1dc75b1d0950992))

# [1.29.0](https://github.com/wanguimbutu/crystal_custom/compare/v1.28.0...v1.29.0) (2026-07-29)


### Features

* **item-order-fulfillment:** scope all stock queries to Finished Goods - CAL ([7fe8603](https://github.com/wanguimbutu/crystal_custom/commit/7fe860333a6c9f35a43c89561e3037e897043c3e))

# [1.28.0](https://github.com/wanguimbutu/crystal_custom/compare/v1.27.1...v1.28.0) (2026-07-27)


### Features

* **weight-consolidation:** Status filter defaulting to Pending Customer Order Reconfirmation ([f75ce06](https://github.com/wanguimbutu/crystal_custom/commit/f75ce06317528e2c5618a28ee800d5b8a209435b))

## [1.27.1](https://github.com/wanguimbutu/crystal_custom/compare/v1.27.0...v1.27.1) (2026-07-27)


### Bug Fixes

* DataError — crystal_closed_trucks KV value exceeded column limit ([2e889a5](https://github.com/wanguimbutu/crystal_custom/commit/2e889a52beea35c92fb34742b06d8433c51d253b))

# [1.27.0](https://github.com/wanguimbutu/crystal_custom/compare/v1.26.0...v1.27.0) (2026-07-24)


### Features

* **finance-manager:** Recently Approved tab with Reverse Approval ([dba0dc8](https://github.com/wanguimbutu/crystal_custom/commit/dba0dc8b361d2d5bbb978cd0f1a787c7f2e8e658))

# [1.26.0](https://github.com/wanguimbutu/crystal_custom/compare/v1.25.5...v1.26.0) (2026-07-22)


### Features

* **truck-assignment:** Crystal Truck Plan as persistent source of truth ([10a718d](https://github.com/wanguimbutu/crystal_custom/commit/10a718d5982bc1ac7ff78235c36bc1c1a8b9ad5f))
* **truck-assignment:** multi-select trucks + selected orders weight/value ([0c82d09](https://github.com/wanguimbutu/crystal_custom/commit/0c82d098a8d30497bb9dcc41306e26acbe2f4db4))

## [1.25.5](https://github.com/wanguimbutu/crystal_custom/compare/v1.25.4...v1.25.5) (2026-06-26)


### Bug Fixes

* batch dispatch truck orders in single SQL call ([41f2140](https://github.com/wanguimbutu/crystal_custom/commit/41f2140a22f5de61cc65d01f21676c14b55b269d))

## [1.25.4](https://github.com/wanguimbutu/crystal_custom/compare/v1.25.3...v1.25.4) (2026-06-26)


### Bug Fixes

* exclude dispatched trucks from assign-to-truck selection ([3094ec0](https://github.com/wanguimbutu/crystal_custom/commit/3094ec04338f29d4bf083b7e616adc0e202c1552))
* truck rotation — dispatched trips no longer block re-use ([01430b3](https://github.com/wanguimbutu/crystal_custom/commit/01430b3cf9d9b4ca109a5607100bd3100cfd992d))

## [1.25.3](https://github.com/wanguimbutu/crystal_custom/compare/v1.25.2...v1.25.3) (2026-06-19)


### Bug Fixes

* MR for new orders skips items already covered by pending MRs ([9ad8f7a](https://github.com/wanguimbutu/crystal_custom/commit/9ad8f7a064a1f764298dd26c7dead7a26f24f9e8))

## [1.25.2](https://github.com/wanguimbutu/crystal_custom/compare/v1.25.1...v1.25.2) (2026-06-19)


### Bug Fixes

* server-side date filtering in Sales Order Manager ([2012c3d](https://github.com/wanguimbutu/crystal_custom/commit/2012c3dd4a1e96768003e13223d1c35368c10a83))

## [1.25.1](https://github.com/wanguimbutu/crystal_custom/compare/v1.25.0...v1.25.1) (2026-06-19)


### Bug Fixes

* sales person filter and text search across all pages ([b20899b](https://github.com/wanguimbutu/crystal_custom/commit/b20899b62ee7ccfdc287a2f290d4cf9d957534ea))

# [1.25.0](https://github.com/wanguimbutu/crystal_custom/compare/v1.24.2...v1.25.0) (2026-06-19)


### Features

* Active/Dispatched sub-tabs + search shows truck assignment in Order Fulfillment ([8763f3e](https://github.com/wanguimbutu/crystal_custom/commit/8763f3e433ea9e2b44839d904b4efd360368e0e1))

## [1.24.2](https://github.com/wanguimbutu/crystal_custom/compare/v1.24.1...v1.24.2) (2026-06-19)


### Bug Fixes

* correct MR shortage calc + pre-fulfilment region Done/Reopen ([1ff7ccf](https://github.com/wanguimbutu/crystal_custom/commit/1ff7ccf5263b92e04b71893dbaa6bf5e369def7b))

## [1.24.1](https://github.com/wanguimbutu/crystal_custom/compare/v1.24.0...v1.24.1) (2026-06-18)


### Bug Fixes

* use custom get_orders endpoint to avoid client get_list field restriction ([b03cdae](https://github.com/wanguimbutu/crystal_custom/commit/b03cdaecebdfa9508e2bb9ef07720c25268f531c))

# [1.24.0](https://github.com/wanguimbutu/crystal_custom/compare/v1.23.0...v1.24.0) (2026-06-18)


### Features

* pre-fulfilment toggle in Sales Order Manager page ([29538d3](https://github.com/wanguimbutu/crystal_custom/commit/29538d36b087cda4f84d036c7d1bf6009a2ab94c))

# [1.23.0](https://github.com/wanguimbutu/crystal_custom/compare/v1.22.0...v1.23.0) (2026-06-18)


### Features

* custom_is_pre_fulfillment flag on Sales Order ([909fe73](https://github.com/wanguimbutu/crystal_custom/commit/909fe7375bc9f1975b95c09e98d010d110feec85))

# [1.22.0](https://github.com/wanguimbutu/crystal_custom/compare/v1.21.0...v1.22.0) (2026-06-18)


### Features

* Crystal Truck Plan doctype + Nairobi region pre-fulfillment bucket ([7f81b04](https://github.com/wanguimbutu/crystal_custom/commit/7f81b04a06126e04d0c76733058c6118faf57a61))

# [1.21.0](https://github.com/wanguimbutu/crystal_custom/compare/v1.20.0...v1.21.0) (2026-06-18)


### Features

* case-insensitive truck search + customer list at bottom of loading sheet ([5f66e1d](https://github.com/wanguimbutu/crystal_custom/commit/5f66e1d3d67593fcc3c3fa11be61e475c82fd2e6))

# [1.20.0](https://github.com/wanguimbutu/crystal_custom/compare/v1.19.1...v1.20.0) (2026-06-18)


### Features

* MR opens for editing; truck close is independent; closed trucks hidden from all tabs ([939002c](https://github.com/wanguimbutu/crystal_custom/commit/939002cf16f1bcf815a0e2dcd78b9577a66f0612))

## [1.19.1](https://github.com/wanguimbutu/crystal_custom/compare/v1.19.0...v1.19.1) (2026-06-18)


### Bug Fixes

* remove all colors from packing list for dot matrix printer compatibility ([a609a89](https://github.com/wanguimbutu/crystal_custom/commit/a609a89cb6b9d73268b3fec863f7e12b3b34f1c8)), closes [#000](https://github.com/wanguimbutu/crystal_custom/issues/000)

# [1.19.0](https://github.com/wanguimbutu/crystal_custom/compare/v1.18.1...v1.19.0) (2026-06-18)


### Features

* per-truck Done/Reopen buttons in Order Fulfillment ([cdd3e0d](https://github.com/wanguimbutu/crystal_custom/commit/cdd3e0df0cb4f6bdd9756e3184f58487e7087eb4))

## [1.18.1](https://github.com/wanguimbutu/crystal_custom/compare/v1.18.0...v1.18.1) (2026-06-17)


### Bug Fixes

* weight consolidation shows only orders with no DN and no invoice ([7ddefbf](https://github.com/wanguimbutu/crystal_custom/commit/7ddefbf3c23c06a547902b377a570c4d18a1b3f7))

# [1.18.0](https://github.com/wanguimbutu/crystal_custom/compare/v1.17.1...v1.18.0) (2026-06-17)


### Features

* multi-select region filter + weight consolidation shows all open orders ([d4569cf](https://github.com/wanguimbutu/crystal_custom/commit/d4569cfde821ddb6fff00b01472deb7662cd208e))

## [1.17.1](https://github.com/wanguimbutu/crystal_custom/compare/v1.17.0...v1.17.1) (2026-06-17)


### Bug Fixes

* selection count in Delivery Note Manager now reflects visible filtered orders ([d0b5d7e](https://github.com/wanguimbutu/crystal_custom/commit/d0b5d7e7ecb13bf72bb5e5bad149a81befe70e3e))

# [1.17.0](https://github.com/wanguimbutu/crystal_custom/compare/v1.16.0...v1.17.0) (2026-06-17)


### Features

* new-order tracking with highlights, New Only LS/PL buttons, per-truck/new MR in order fulfilment ([5a2579f](https://github.com/wanguimbutu/crystal_custom/commit/5a2579ffccac2ccfaf2b29a3073fd0a708cd284f))

# [1.16.0](https://github.com/wanguimbutu/crystal_custom/compare/v1.15.3...v1.16.0) (2026-06-17)


### Features

* bold item names in print docs + debt check on finance approval ([a369de5](https://github.com/wanguimbutu/crystal_custom/commit/a369de5275da3dab2b9485c4de98741c0b2271c3))

## [1.15.3](https://github.com/wanguimbutu/crystal_custom/compare/v1.15.2...v1.15.3) (2026-06-16)


### Bug Fixes

* apply date range filter to paint/colour specs in production overview ([35c36a2](https://github.com/wanguimbutu/crystal_custom/commit/35c36a2a82fc0ae6ec2d2322e78e188b16bedc6c))

## [1.15.2](https://github.com/wanguimbutu/crystal_custom/compare/v1.15.1...v1.15.2) (2026-06-16)


### Bug Fixes

* detect paint notes column name dynamically to avoid crash ([fc683d7](https://github.com/wanguimbutu/crystal_custom/commit/fc683d744d46e13c14f88f9c92ac2f5d857d0615))

## [1.15.1](https://github.com/wanguimbutu/crystal_custom/compare/v1.15.0...v1.15.1) (2026-06-16)


### Bug Fixes

* delivery note manager table view shows all truck-assigned orders ([cb93e01](https://github.com/wanguimbutu/crystal_custom/commit/cb93e017cfb2ae91326835c983fa367bdf707a34))

# [1.15.0](https://github.com/wanguimbutu/crystal_custom/compare/v1.14.6...v1.15.0) (2026-06-16)


### Bug Fixes

* remove non-existent custom_additonal_notes column from paint orders query ([9a206be](https://github.com/wanguimbutu/crystal_custom/commit/9a206be9967664fd94ec1481fb48b8b411031b20))
* use custom_additonal_notes (actual SO field) for paint/colour notes ([4215ae1](https://github.com/wanguimbutu/crystal_custom/commit/4215ae18542d5acaf72826b97a28472dfa0c1671))


### Features

* full search in order fulfillment (item, truck, order, region, sales person) ([0770926](https://github.com/wanguimbutu/crystal_custom/commit/0770926c05c2ab6609814c853817088a6fb11f10))

## [1.14.6](https://github.com/wanguimbutu/crystal_custom/compare/v1.14.5...v1.14.6) (2026-06-16)


### Bug Fixes

* mirror truck assignment filters exactly in order fulfillment ([68186e3](https://github.com/wanguimbutu/crystal_custom/commit/68186e38ed0a76fcadf6bc3c72eccd9f4b5cae64))

## [1.14.5](https://github.com/wanguimbutu/crystal_custom/compare/v1.14.4...v1.14.5) (2026-06-16)


### Bug Fixes

* derive dispatched trucks from order state not KV store ([cff00f1](https://github.com/wanguimbutu/crystal_custom/commit/cff00f1d4e40a53317e55b88903c678ef865eb3f))

## [1.14.4](https://github.com/wanguimbutu/crystal_custom/compare/v1.14.3...v1.14.4) (2026-06-16)


### Bug Fixes

* derive truck is_closed from KV store not custom_truck_closed field ([8a0dd06](https://github.com/wanguimbutu/crystal_custom/commit/8a0dd063b63c439708f31d1d6b1a5f18ee233902))

## [1.14.3](https://github.com/wanguimbutu/crystal_custom/compare/v1.14.2...v1.14.3) (2026-06-16)


### Bug Fixes

* order fulfillment shows all truck-assigned orders regardless of status ([06517b1](https://github.com/wanguimbutu/crystal_custom/commit/06517b19462f083ecbf04269c562fd9b27de8f91))

## [1.14.2](https://github.com/wanguimbutu/crystal_custom/compare/v1.14.1...v1.14.2) (2026-06-16)


### Bug Fixes

* remove workflow state filter from order fulfillment queries ([a06b878](https://github.com/wanguimbutu/crystal_custom/commit/a06b8781ba7e6ad8272a8c6c684273336425e796))

## [1.14.1](https://github.com/wanguimbutu/crystal_custom/compare/v1.14.0...v1.14.1) (2026-06-16)


### Bug Fixes

* align order fulfillment queries with truck assignment filters ([9119934](https://github.com/wanguimbutu/crystal_custom/commit/911993485c161c9ef60d6203d1fd7cdf10725758))

# [1.14.0](https://github.com/wanguimbutu/crystal_custom/compare/v1.13.0...v1.14.0) (2026-06-16)


### Features

* separate Sorted Trucks into own tab in order fulfillment ([a4a8b81](https://github.com/wanguimbutu/crystal_custom/commit/a4a8b81843417b293f73866bb4da8a0a8ca74683))

# [1.13.0](https://github.com/wanguimbutu/crystal_custom/compare/v1.12.0...v1.13.0) (2026-06-16)


### Features

* close & mark sorted button on fulfillment trucks; closed trucks fully functional ([49e3d62](https://github.com/wanguimbutu/crystal_custom/commit/49e3d62a9e3322a34b77d123acb5f8aa961177c9))

# [1.12.0](https://github.com/wanguimbutu/crystal_custom/compare/v1.11.0...v1.12.0) (2026-06-16)


### Features

* show delivery region on truck cards in order fulfillment ([cad71bd](https://github.com/wanguimbutu/crystal_custom/commit/cad71bdee51f77ac7f2a4f6d67dabd9377c54a07))

# [1.11.0](https://github.com/wanguimbutu/crystal_custom/compare/v1.10.3...v1.11.0) (2026-06-16)


### Bug Fixes

* read colour notes from custom_additonal_notes field on Sales Order ([1b5a2c2](https://github.com/wanguimbutu/crystal_custom/commit/1b5a2c23060db2a90004d69de2ab589809ce257d))


### Features

* show live order total in order confirmation item editor ([8ad23af](https://github.com/wanguimbutu/crystal_custom/commit/8ad23af47d5f1fe3901008e5afc6eb3afabbba3d))

## [1.10.3](https://github.com/wanguimbutu/crystal_custom/compare/v1.10.2...v1.10.3) (2026-06-16)


### Bug Fixes

* dedup dispatched trucks, show worksheets tab, phone numbers from customer, pdc totals ([7590906](https://github.com/wanguimbutu/crystal_custom/commit/75909063c301fe005cb02d7afde653adfb9ad7bd))

## [1.10.2](https://github.com/wanguimbutu/crystal_custom/compare/v1.10.1...v1.10.2) (2026-06-16)


### Bug Fixes

* remove all paint_manufacture app references from production overview ([92e32e8](https://github.com/wanguimbutu/crystal_custom/commit/92e32e87cd73db3e5cde592def4185db8d2ef7c7))

## [1.10.1](https://github.com/wanguimbutu/crystal_custom/compare/v1.10.0...v1.10.1) (2026-06-16)


### Bug Fixes

* remove non-existent custom_source_page column from MR query ([998aeba](https://github.com/wanguimbutu/crystal_custom/commit/998aeba9b9a2ac07cee1ada58adf53854cb22734))

# [1.10.0](https://github.com/wanguimbutu/crystal_custom/compare/v1.9.0...v1.10.0) (2026-06-16)


### Features

* Paint/Colour Notes field — visible across all pages and production ([0b628d5](https://github.com/wanguimbutu/crystal_custom/commit/0b628d54f40982444c77c8338e2216dfc069f839))

# [1.9.0](https://github.com/wanguimbutu/crystal_custom/compare/v1.8.2...v1.9.0) (2026-06-16)


### Features

* Production Overview page ([863bbec](https://github.com/wanguimbutu/crystal_custom/commit/863bbecde25a24789ab5344d85dcef07349020de))

## [1.8.2](https://github.com/wanguimbutu/crystal_custom/compare/v1.8.1...v1.8.2) (2026-06-16)


### Bug Fixes

* hide submitted orders from table view; remove duplicate totals from packing list ([70fe814](https://github.com/wanguimbutu/crystal_custom/commit/70fe8148afdf59e93ba19be9ef5aae23240fd017))

## [1.8.1](https://github.com/wanguimbutu/crystal_custom/compare/v1.8.0...v1.8.1) (2026-06-16)


### Bug Fixes

* loading sheet uses full order qty; truck assignment enforces capacity hard limit ([b0da80d](https://github.com/wanguimbutu/crystal_custom/commit/b0da80dd0c9d3fd5a1c17702fba76725beaaf3cc))

# [1.8.0](https://github.com/wanguimbutu/crystal_custom/compare/v1.7.0...v1.8.0) (2026-06-16)


### Features

* Loading Sheet and Packing List buttons on each truck card in DN Manager ([1121b62](https://github.com/wanguimbutu/crystal_custom/commit/1121b62fea46b9dce356304a6e61e46b632dbc95))

# [1.7.0](https://github.com/wanguimbutu/crystal_custom/compare/v1.6.0...v1.7.0) (2026-06-16)


### Features

* inline order editor on Customer Order Confirmation page ([aee4376](https://github.com/wanguimbutu/crystal_custom/commit/aee4376bb0e7e37579e80c5cac5b9640ad516153))

# [1.6.0](https://github.com/wanguimbutu/crystal_custom/compare/v1.5.0...v1.6.0) (2026-06-16)


### Features

* print and download buttons for Customer View in Order Fulfillment ([08a3861](https://github.com/wanguimbutu/crystal_custom/commit/08a38613c9612377666143b4008714f70ae16ae4))

# [1.5.0](https://github.com/wanguimbutu/crystal_custom/compare/v1.4.0...v1.5.0) (2026-06-16)


### Features

* auto-close trucks + Stock Overview tab in Order Fulfillment ([404c922](https://github.com/wanguimbutu/crystal_custom/commit/404c922f346a4a64e889d88f1eabf73ca71ef205))

# [1.4.0](https://github.com/wanguimbutu/crystal_custom/compare/v1.3.0...v1.4.0) (2026-06-15)


### Features

* show pending (draft) truck orders in DN Manager truck view ([59d0011](https://github.com/wanguimbutu/crystal_custom/commit/59d00119429ee37676deb55bd30fcf77083aeaf9))

# [1.3.0](https://github.com/wanguimbutu/crystal_custom/compare/v1.2.2...v1.3.0) (2026-06-15)


### Features

* show all trucks (active + dispatched) in DN Manager truck view ([7ec868c](https://github.com/wanguimbutu/crystal_custom/commit/7ec868c5dc10dbd6e467f5537b76709aa191dd75))

## [1.2.2](https://github.com/wanguimbutu/crystal_custom/compare/v1.2.1...v1.2.2) (2026-06-15)


### Bug Fixes

* truck-assigned orders always visible in DN Manager truck view ([6e09f97](https://github.com/wanguimbutu/crystal_custom/commit/6e09f970aaa2c57502be2c897c2500ba8761e127))

## [1.2.1](https://github.com/wanguimbutu/crystal_custom/compare/v1.2.0...v1.2.1) (2026-06-15)


### Bug Fixes

* truck-assigned orders persist in truck cards regardless of date filter ([98c6d29](https://github.com/wanguimbutu/crystal_custom/commit/98c6d2920829661cb9f2ac5ebd6dd1f4b373d7a9))

# [1.2.0](https://github.com/wanguimbutu/crystal_custom/compare/v1.1.0...v1.2.0) (2026-06-15)


### Features

* auto-fill DN vehicle/driver from truck assignment; add Truck View to status page ([aed3d97](https://github.com/wanguimbutu/crystal_custom/commit/aed3d971165ea537b3c74082c0be8255e81e175c))

# [1.1.0](https://github.com/wanguimbutu/crystal_custom/compare/v1.0.0...v1.1.0) (2026-04-14)


### Features

* sales report ([8d2ff78](https://github.com/wanguimbutu/crystal_custom/commit/8d2ff7803443853216b71e9127b44a2c7bcabdaf))

# 1.0.0 (2025-12-01)


### Features

* Initialize App ([2538c4b](https://github.com/wanguimbutu/crystal_custom/commit/2538c4baeaa1e0762d2dea800aa44377f315f21c))
