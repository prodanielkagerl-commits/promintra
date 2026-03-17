using { my.namespace as db } from '../db/schema';

@path:'/admin'
service AdminService {
  entity Products         as projection on db.Products;
  entity ProductImages    as projection on db.ProductImages;
  entity Campaigns        as projection on db.Campaigns;
  entity Clients          as projection on db.Clients;
  entity ProductCampaigns as projection on db.ProductCampaigns;
}

annotate AdminService.Products with @(
  UI.LineItem: [
    { Value: image, Label: 'Imagen' },
    { Value: code, Label: 'Código' },
    { Value: name, Label: 'Nombre' },
    { Value: type, Label: 'Tipo' },
    { Value: grossPrice, Label: 'Precio bruto' },
    { Value: netPrice, Label: 'Precio neto' },
    { Value: stock, Label: 'Stock' }
  ],
  UI.SelectionFields: [ code, name, type ]
);

annotate AdminService.Products with {
  image @UI.IsImageURL;
};
