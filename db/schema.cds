namespace my.namespace;

using { cuid, managed } from '@sap/cds/common';

entity Products : cuid, managed {
  code        : String(30) @mandatory;
  name        : String(120) @mandatory;
  type        : String(40) @mandatory;
  image       : String(255) @assert.format: '^.*\.(png|jpg|jpeg)$';
  weight      : Decimal(9,2);
  grossPrice  : Decimal(9,2);
  netPrice    : Decimal(9,2);
  stock       : Integer default 0;
  images      : Composition of many ProductImages
                  on images.product = $self;
  campaigns   : Association to many ProductCampaigns
                  on campaigns.product = $self;
}

entity ProductImages : cuid, managed {
  product    : Association to Products @mandatory;
  imageUrl   : String(255) @mandatory @assert.format: '^.*\.(png|jpg|jpeg)$';
  isCover    : Boolean default false;
  sortOrder  : Integer default 1;
}

entity Campaigns : cuid, managed {
  name        : String(120) @mandatory;
  description : String(500);
  startDate   : Date;
  endDate     : Date;
  client      : Association to Clients;
  products    : Association to many ProductCampaigns
                  on products.campaign = $self;
}

entity Clients : cuid, managed {
  code        : String(30) @mandatory;
  name        : String(120) @mandatory;
  contactName : String(120);
  email       : String(120);
  phone       : String(40);
  city        : String(80);
  country     : String(80);
}

entity ProductCampaigns : managed {
  key product  : Association to Products;
  key campaign : Association to Campaigns;
}
