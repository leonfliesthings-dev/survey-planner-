import { TestBed } from '@angular/core/testing';
import { App } from './app';

describe('App', () => {
  beforeEach(async () => {
    await TestBed.configureTestingModule({ imports: [App] }).compileComponents();
  });

  // Note: we don't run change detection here — that would trigger the survey
  // planner's Leaflet map init, which needs a real (non-jsdom) DOM. Engine logic
  // is covered by the survey-engine specs.
  it('should create the app', () => {
    const fixture = TestBed.createComponent(App);
    expect(fixture.componentInstance).toBeTruthy();
  });
});
